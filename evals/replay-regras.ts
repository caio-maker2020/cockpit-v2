// =============================================================================
// evals/replay-regras.ts — Replay eval do Loop de Aprendizado (F6).
//
// Pergunta que responde: "se o agente conhecesse a REGRA NOVA, teria acertado
// nos casos em que o time corrigiu?" Compara em N casos históricos reais:
//   BASELINE  = o que o agente sugeriu na época (gravado em decisao_ia)
//   COM REGRA = o que um juiz LLM decide vendo o MESMO contexto + a regra nova
// contra o GABARITO (decisão final do operador — spec D1).
//
// Uso:
//   set -a && source .env.local && set +a
//   deno run --allow-net --allow-env evals/replay-regras.ts \
//     --chave "agente-sugere-ocs-padrao:sug56" \
//     --regra "QUANDO houver foto do canhoto, notificar o cliente (54) mesmo sem ressalva escrita" \
//     [--limit 20]
//
// Sem efeitos colaterais: só lê o banco e chama a Anthropic. O laudo sai no
// stdout — o /f6-aplicar-melhorias anexa ao PR.
// =============================================================================

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i += 2) {
  args.set(Deno.args[i].replace(/^--/, ""), Deno.args[i + 1] ?? "");
}
const chave = args.get("chave");
const regra = args.get("regra");
const limit = Math.min(50, Number(args.get("limit")) || 20);
const modelo = args.get("modelo") || "claude-sonnet-4-6";
if (!chave || !regra) {
  console.error("uso: --chave <agente:sugNN> --regra <texto> [--limit N]");
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
  console.error("faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ANTHROPIC_API_KEY no env");
  Deno.exit(1);
}

// ---------- 1. casos históricos (label = decisão final do operador)
const filtroSug = ocSugerida === null ? "oc_sugerida=is.null" : `oc_sugerida=eq.${ocSugerida}`;
const url = `${SUPABASE_URL}/rest/v1/v_sinal_ouro_casos` +
  `?agent_name=eq.${encodeURIComponent(agentName)}&${filtroSug}` +
  `&veredito=in.(seguida,corrigida)&order=decidido_em.desc&limit=${limit}` +
  `&select=nf,veredito,oc_card,oc_sugerida,oc_executada,decisao_ia`;
const resp = await fetch(url, {
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
});
if (!resp.ok) {
  console.error(`erro lendo casos: ${resp.status} ${await resp.text()}`);
  Deno.exit(1);
}
type Caso = {
  nf: string | null;
  veredito: string;
  oc_card: number | null;
  oc_sugerida: number | null;
  oc_executada: number | null;
  decisao_ia: Record<string, unknown> | null;
};
const casos = (await resp.json()) as Caso[];
if (casos.length < 5) {
  console.error(`só ${casos.length} casos — mínimo 5 pra um laudo honesto`);
  Deno.exit(1);
}

// gabarito: seguida → a própria sugestão; corrigida → o que o time lançou
const rotulo = (c: Caso): number | null =>
  c.veredito === "seguida" ? c.oc_sugerida : c.oc_executada;

// ---------- 2. juiz LLM com a regra nova
async function decidirComRegra(c: Caso): Promise<number | null> {
  const d = c.decisao_ia ?? {};
  const contexto = {
    ocorrencia_do_card: c.oc_card,
    observacao_do_agente_na_epoca: d["observacao_orquestrador"] ?? d["motivo"] ?? null,
    motivo_extraido: d["motivo_extraido"] ?? null,
    foto_classificacao: d["foto_classificacao"] ?? null,
    ressalva_texto: d["ressalva_texto"] ?? null,
  };
  const body = {
    model: modelo,
    max_tokens: 60,
    temperature: 0,
    system:
      "Você decide a próxima ocorrência SSW de um card de transportadora. " +
      "Aplique RIGOROSAMENTE a regra nova fornecida ao contexto. " +
      "Responda APENAS o número da ocorrência (ex.: 54). Nada mais.",
    messages: [{
      role: "user",
      content: `REGRA NOVA (aprovada pela gestão): ${regra}\n\n` +
        `CONTEXTO DO CASO: ${JSON.stringify(contexto)}\n\n` +
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
  const texto: string = j?.content?.[0]?.text ?? "";
  const num = /\d+/.exec(texto)?.[0];
  return num ? Number(num) : null;
}

// ---------- 3. replay
let baselineOk = 0;
let regraOk = 0;
let julgados = 0;
const detalhes: string[] = [];
for (const c of casos) {
  const label = rotulo(c);
  if (label === null) continue;
  const veioDaRegra = await decidirComRegra(c);
  if (veioDaRegra === null) continue;
  julgados += 1;
  if (c.oc_sugerida === label) baselineOk += 1;
  if (veioDaRegra === label) regraOk += 1;
  detalhes.push(
    `NF ${c.nf}: gabarito=${label} baseline=${c.oc_sugerida} regra=${veioDaRegra}` +
      `${veioDaRegra === label ? " ✓" : " ✗"}`,
  );
}

const pct = (n: number) => julgados > 0 ? Math.round((1000 * n) / julgados) / 10 : 0;
console.log("=".repeat(60));
console.log(`REPLAY — ${chave}`);
console.log(`regra: ${regra}`);
console.log(`casos julgados: ${julgados}`);
console.log(`BASELINE (agente na época): ${pct(baselineOk)}% de acerto`);
console.log(`COM A REGRA NOVA:           ${pct(regraOk)}% de acerto`);
console.log(
  pct(regraOk) > pct(baselineOk)
    ? `VEREDITO: MELHORA (+${(pct(regraOk) - pct(baselineOk)).toFixed(1)} pontos)`
    : pct(regraOk) === pct(baselineOk)
    ? "VEREDITO: EMPATE — regra não muda o resultado nesta amostra"
    : `VEREDITO: PIORA (${(pct(regraOk) - pct(baselineOk)).toFixed(1)} pontos) — NÃO aplicar`,
);
console.log("-".repeat(60));
for (const d of detalhes) console.log(d);
