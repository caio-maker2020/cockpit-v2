// =============================================================================
// evals/replay-regras.ts — Replay eval do Loop de Aprendizado (F6).
//
// Pergunta que responde: "se o agente conhecesse a REGRA NOVA, teria acertado
// nos casos em que o time corrigiu — sem estragar os casos em que ele já
// acertava?" Compara, em casos históricos reais:
//   BASELINE  = o que o agente sugeriu na época (gravado em decisao_ia)
//   COM REGRA = o que um juiz LLM decide vendo o MESMO contexto + a regra nova
// contra o GABARITO (decisão final do operador — spec D1).
//
// v2 (2026-08-04) — o juiz agora enxerga a EVIDÊNCIA que as regras citam:
//   • texto do e-mail do cliente (messages_inbox, via decisao_ia.message_id)
//   • GPS do lançamento (distância/threshold)
//   • decisao_ia completa (menos campos de ruído)
//   • catálogo das ocorrências possíveis (antes ele chutava códigos)
//   • COORTE DE CONTROLE: casos em que o agente JÁ ACERTAVA, pra provar que a
//     regra não quebra o que funciona (veredito exige ganho no padrão E
//     ausência de regressão no controle).
// Motivo: na v1 o juiz recebia só oc/observação/foto/ressalva — as regras da
// gestão falam de e-mail e GPS, então ele julgava às cegas e reprovava regra
// boa (replay de 03/08: -5 e -42 pontos, ambos inconclusivos por cegueira).
//
// Uso:
//   set -a && source .env.local && set +a
//   deno run --allow-net --allow-env evals/replay-regras.ts \
//     --chave "agente-sugere-ocs-padrao:sug56" \
//     --regra "QUANDO houver foto do canhoto, notificar o cliente (54)..." \
//     [--limit 20] [--controle 12] [--modelo claude-sonnet-4-6] [--verbose]
//
// Sem efeitos colaterais: só lê o banco e chama a Anthropic. O laudo sai no
// stdout — o /f6-aplicar-melhorias anexa ao PR.
// =============================================================================

// ------------------------------- argumentos -------------------------------
const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i += 2) {
  args.set(Deno.args[i].replace(/^--/, ""), Deno.args[i + 1] ?? "");
}
const chave = args.get("chave");
const regra = args.get("regra");
const limit = Math.min(50, Number(args.get("limit")) || 20);
const limitControle = Math.min(30, Number(args.get("controle")) || 12);
const modelo = args.get("modelo") || "claude-sonnet-4-6";
const verbose = Deno.args.includes("--verbose");

if (!chave || !regra) {
  console.error(
    "uso: --chave <agente:sugNN> --regra <texto> [--limit N] [--controle N]",
  );
  Deno.exit(1);
}
const m = /^(.+):sug(\d+|sem)$/.exec(chave);
if (!m) {
  console.error(`chave inválida: ${chave}`);
  Deno.exit(1);
}
const agentName = m[1];
const ocSugerida = m[2] === "sem" ? null : Number(m[2]);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
  console.error(
    "faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ANTHROPIC_API_KEY no env",
  );
  Deno.exit(1);
}

const MIN_CASOS = 5;
const MAX_EMAIL_CHARS = 4000;
const CHUNK_IDS = 50; // >~100 ids numa URL do PostgREST estoura (lição 23/07)
const TOLERANCIA_CONTROLE_PTS = 5; // queda aceitável no controle

// -------------------------------- tipos -----------------------------------
interface Caso {
  nf: string | null;
  veredito: string;
  oc_card: number | null;
  oc_sugerida: number | null;
  oc_executada: number | null;
  decisao_ia: Record<string, unknown> | null;
}

// ------------------------------ helpers de I/O -----------------------------
async function rest(path: string): Promise<unknown> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return await r.json();
}

/** Casos do padrão (agente + oc sugerida) ou do controle (agente, só acertos). */
async function buscarCasos(opts: {
  soAcertos: boolean;
  limite: number;
  mesmaOcSugerida: boolean;
}): Promise<Caso[]> {
  const filtros = [`agent_name=eq.${encodeURIComponent(agentName)}`];
  if (opts.mesmaOcSugerida) {
    filtros.push(ocSugerida === null ? "oc_sugerida=is.null" : `oc_sugerida=eq.${ocSugerida}`);
  } else if (ocSugerida !== null) {
    // controle: casos FORA do padrão (outra oc sugerida) em que o agente acertou
    filtros.push(`oc_sugerida=neq.${ocSugerida}`);
  }
  filtros.push(opts.soAcertos ? "veredito=eq.seguida" : "veredito=in.(seguida,corrigida)");
  const q = `v_sinal_ouro_casos?${filtros.join("&")}` +
    `&order=decidido_em.desc&limit=${opts.limite}` +
    `&select=nf,veredito,oc_card,oc_sugerida,oc_executada,decisao_ia`;
  return (await rest(q)) as Caso[];
}

/** E-mail do cliente que originou a decisão (o que a v1 não enxergava). */
async function buscarEmails(casos: Caso[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      casos
        .map((c) => (c.decisao_ia ?? {})["message_id"])
        .filter((v): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/.test(v)),
    ),
  ];
  const mapa = new Map<string, string>();
  for (let i = 0; i < ids.length; i += CHUNK_IDS) {
    const bloco = ids.slice(i, i + CHUNK_IDS);
    const rows = (await rest(
      `messages_inbox?id=in.(${bloco.join(",")})&select=id,conteudo`,
    )) as Array<{ id: string; conteudo: string | null }>;
    for (const r of rows) {
      if (r.conteudo) mapa.set(r.id, limparEmail(r.conteudo));
    }
  }
  return mapa;
}

function limparEmail(txt: string): string {
  return txt
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, MAX_EMAIL_CHARS);
}

/** Catálogo das ocorrências plausíveis — na v1 o juiz chutava códigos. */
async function buscarCatalogo(codigos: number[]): Promise<string> {
  const base = [10, 11, 13, 19, 20, 21, 33, 35, 44, 49, 54, 55, 56, 59];
  const lista = [...new Set([...base, ...codigos])].filter((n) => Number.isFinite(n));
  const rows = (await rest(
    `ocorrencias_dicionario?codigo=in.(${lista.join(",")})&select=codigo,descricao`,
  )) as Array<{ codigo: number; descricao: string }>;
  return rows
    .sort((a, b) => a.codigo - b.codigo)
    .map((r) => `${r.codigo} = ${r.descricao}`)
    .join(" | ");
}

// --------------------------- contexto e julgamento -------------------------
const RUIDO = new Set([
  "corpo_email_sugerido", // o e-mail que a IA redigiu — não é evidência do caso
  "template_email_sugerido",
  "proposta_destacada_acao",
  "sugerido_em",
  "message_id",
]);

function montarContexto(c: Caso, email: string | null): Record<string, unknown> {
  const d = { ...(c.decisao_ia ?? {}) } as Record<string, unknown>;
  for (const k of RUIDO) delete d[k];
  return {
    ocorrencia_atual_do_card: c.oc_card,
    email_do_cliente: email ?? "(sem e-mail vinculado a este caso)",
    gps_distancia_metros: d["gps_distancia_metros"] ?? null,
    gps_dentro_do_esperado: d["gps_dentro_threshold"] ?? null,
    evidencia_e_leitura_do_agente: d,
  };
}

/**
 * Um julgamento. `comRegra=false` é o BRAÇO DE CONTROLE do experimento:
 * o mesmo juiz, no mesmo caso, SEM a regra nova.
 *
 * Por que existe (achado de 04/08): comparar "juiz com regra" contra "o que o
 * agente sugeriu na época" mistura dois efeitos — o da regra e o de o juiz ser
 * um decisor diferente do agente. Teste da hipótese nula provou o estrago:
 * rodando SEM regra nenhuma, a coorte de controle já caía 75 pts. Todo veredito
 * de "quebra o controle" anterior media juiz≠agente, não dano da regra.
 * O efeito real da regra só aparece em: (juiz COM regra) − (juiz SEM regra).
 */
async function julgar(
  c: Caso,
  email: string | null,
  catalogo: string,
  comRegra: boolean,
): Promise<number | null> {
  const body = {
    model: modelo,
    max_tokens: 60,
    temperature: 0,
    system:
      "Você decide qual ocorrência SSW lançar num card de transportadora. " +
      (comRegra
        ? "Aplique RIGOROSAMENTE a REGRA fornecida ao contexto do caso. " +
          "Se a regra não se aplicar a este caso, decida pelo bom senso operacional " +
          "e pela evidência apresentada. "
        : "Decida pelo bom senso operacional e pela evidência apresentada. ") +
      "Responda APENAS o número da ocorrência.\n\n" +
      `Ocorrências possíveis: ${catalogo}`,
    messages: [{
      role: "user",
      content: (comRegra ? `REGRA (aprovada pela gestão):\n${regra}\n\n` : "") +
        `CONTEXTO DO CASO:\n${JSON.stringify(montarContexto(c, email), null, 1)}\n\n` +
        `Qual ocorrência lançar? Responda só o número.`,
    }],
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const num = /\d+/.exec(j?.content?.[0]?.text ?? "")?.[0];
  return num ? Number(num) : null;
}

/** gabarito: seguida → a própria sugestão; corrigida → o que o time lançou */
const rotulo = (c: Caso): number | null =>
  c.veredito === "seguida" ? c.oc_sugerida : c.oc_executada;

interface Resultado {
  julgados: number;
  agenteOk: number; // referência histórica: o que o agente sugeriu na época
  semRegraOk: number; // braço de controle: o MESMO juiz sem a regra
  comRegraOk: number; // braço de tratamento
  detalhes: string[];
  comEmail: number;
}

async function rodar(casos: Caso[], emails: Map<string, string>, catalogo: string): Promise<Resultado> {
  const res: Resultado = {
    julgados: 0,
    agenteOk: 0,
    semRegraOk: 0,
    comRegraOk: 0,
    detalhes: [],
    comEmail: 0,
  };
  for (const c of casos) {
    const label = rotulo(c);
    if (label === null) continue;
    const mid = (c.decisao_ia ?? {})["message_id"];
    const email = typeof mid === "string" ? emails.get(mid) ?? null : null;
    const [sem, com] = await Promise.all([
      julgar(c, email, catalogo, false),
      julgar(c, email, catalogo, true),
    ]);
    if (sem === null || com === null) continue;
    res.julgados += 1;
    if (email) res.comEmail += 1;
    if (c.oc_sugerida === label) res.agenteOk += 1;
    if (sem === label) res.semRegraOk += 1;
    if (com === label) res.comRegraOk += 1;
    const efeito = com === label && sem !== label
      ? " ⬆ regra resolveu"
      : sem === label && com !== label
      ? " ⬇ regra estragou"
      : "";
    res.detalhes.push(
      `NF ${c.nf}: gabarito=${label} agente=${c.oc_sugerida} juiz_sem=${sem} juiz_com=${com}${efeito}`,
    );
  }
  return res;
}

const pct = (n: number, total: number) =>
  total > 0 ? Math.round((1000 * n) / total) / 10 : 0;

// ---------------------------------- main ----------------------------------
const casosPadrao = await buscarCasos({ soAcertos: false, limite: limit, mesmaOcSugerida: true });
if (casosPadrao.length < MIN_CASOS) {
  console.error(`só ${casosPadrao.length} casos no padrão — mínimo ${MIN_CASOS} pra um laudo honesto`);
  Deno.exit(1);
}
const casosControle = await buscarCasos({
  soAcertos: true,
  limite: limitControle,
  mesmaOcSugerida: false,
});

const emails = await buscarEmails([...casosPadrao, ...casosControle]);
const catalogo = await buscarCatalogo(
  [...casosPadrao, ...casosControle].flatMap((c) => [c.oc_card, c.oc_sugerida, c.oc_executada])
    .filter((n): n is number => typeof n === "number"),
);

const padrao = await rodar(casosPadrao, emails, catalogo);
const controle = casosControle.length > 0
  ? await rodar(casosControle, emails, catalogo)
  : null;

const agenteP = pct(padrao.agenteOk, padrao.julgados);
const semP = pct(padrao.semRegraOk, padrao.julgados);
const comP = pct(padrao.comRegraOk, padrao.julgados);
// EFEITO DA REGRA = tratamento − controle, com o MESMO juiz
const efeitoPadrao = Math.round((comP - semP) * 10) / 10;

const semC = controle ? pct(controle.semRegraOk, controle.julgados) : null;
const comC = controle ? pct(controle.comRegraOk, controle.julgados) : null;
const efeitoControle = semC !== null && comC !== null
  ? Math.round((comC - semC) * 10) / 10
  : null;

const regrediuControle = efeitoControle !== null && efeitoControle < -TOLERANCIA_CONTROLE_PTS;

console.log("=".repeat(64));
console.log(`REPLAY v3 — ${chave}`);
console.log(`modelo do juiz: ${modelo}`);
console.log(`regra: ${regra.slice(0, 240)}${regra.length > 240 ? "…" : ""}`);
console.log("-".repeat(64));
console.log(`PADRÃO (bolsão de erro): ${padrao.julgados} casos · ${padrao.comEmail} com e-mail`);
console.log(`  referência — o agente na época: ${agenteP}%`);
console.log(`  juiz SEM a regra:              ${semP}%`);
console.log(`  juiz COM a regra:              ${comP}%`);
console.log(`  ➜ EFEITO DA REGRA: ${efeitoPadrao >= 0 ? "+" : ""}${efeitoPadrao} pts`);
if (controle && controle.julgados > 0) {
  console.log(`CONTROLE (casos que já davam certo): ${controle.julgados} casos`);
  console.log(`  juiz SEM a regra: ${semC}%  →  juiz COM a regra: ${comC}%`);
  console.log(`  ➜ EFEITO COLATERAL: ${efeitoControle! >= 0 ? "+" : ""}${efeitoControle} pts`);
} else {
  console.log("CONTROLE: sem casos suficientes — efeito colateral NÃO verificado");
}
console.log("-".repeat(64));
if (efeitoPadrao > 0 && !regrediuControle) {
  console.log(`VEREDITO: MELHORA (+${efeitoPadrao} pts no padrão, sem dano colateral)`);
} else if (efeitoPadrao > 0 && regrediuControle) {
  console.log(`VEREDITO: MELHORA NO PADRÃO MAS CAUSA DANO COLATERAL (${efeitoControle} pts) — NÃO aplicar como está`);
} else if (efeitoPadrao === 0) {
  console.log("VEREDITO: EMPATE — a regra não muda a decisão nesta amostra");
} else {
  console.log(`VEREDITO: PIORA (${efeitoPadrao} pts) — NÃO aplicar`);
}
if (verbose) {
  console.log("-".repeat(64));
  console.log("PADRÃO:");
  for (const d of padrao.detalhes) console.log("  " + d);
  if (controle) {
    console.log("CONTROLE:");
    for (const d of controle.detalhes) console.log("  " + d);
  }
}
