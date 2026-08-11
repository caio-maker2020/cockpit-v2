// =============================================================================
// evals/calibrar-devolucao-oc10.ts — mede o detector da capacidade A contra a
// base REAL de produção, antes de ligá-lo no agente.
//
// Pergunta que responde: "se o agente-sugere-ocs-padrao consultasse os e-mails
// do card antes de decidir a oc 10, quantos dos casos que o time corrigiu pra
// 44 ele recuperaria — e quantos dos que ele JÁ acerta ele estragaria?"
//
//   BOLSÃO   = oc_card 10, agente sugeriu 54/56, time lançou 44  → recall
//   CONTROLE = oc_card 10, agente sugeriu 54, time SEGUIU        → falso positivo
//
// Só lê o banco (REST, service role). Nenhum efeito colateral, nenhuma chamada
// de IA. O laudo sai no stdout e vai pro corpo do PR.
//
// Uso:
//   set -a && source .env.local && set +a
//   deno run --allow-net --allow-env evals/calibrar-devolucao-oc10.ts
// =============================================================================

import { detectarDevolucaoNasMensagens } from "../supabase/functions/_shared/email-devolucao-solicitada.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no env");
  Deno.exit(1);
}

const CHUNK_IDS = 50; // >~100 ids numa URL do PostgREST estoura (lição 23/07)

interface Caso {
  card_id: string;
  nf: string | null;
  decidido_em: string;
  oc_sugerida: number | null;
  oc_executada: number | null;
}

interface Msg {
  card_id: string;
  conteudo: string | null;
  recebido_em: string | null;
  remetente: string | null;
}

async function rest(path: string): Promise<unknown> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return await r.json();
}

async function buscarCasos(filtros: string[], limite: number): Promise<Caso[]> {
  const q = `v_sinal_ouro_casos?agent_name=eq.agente-sugere-ocs-padrao&oc_card=eq.10&` +
    `${filtros.join("&")}&order=decidido_em.desc&limit=${limite}` +
    `&select=card_id,nf,decidido_em,oc_sugerida,oc_executada`;
  return (await rest(q)) as Caso[];
}

/** Mensagens recebidas ANTES da decisão, por card. */
async function mensagensAntesDaDecisao(casos: Caso[]): Promise<Map<string, Msg[]>> {
  const porCard = new Map<string, Msg[]>();
  const ids = [...new Set(casos.map((c) => c.card_id))];
  for (let i = 0; i < ids.length; i += CHUNK_IDS) {
    const lote = ids.slice(i, i + CHUNK_IDS);
    const msgs = (await rest(
      `messages_inbox?card_id=in.(${lote.join(",")})&order=recebido_em.desc&select=card_id,conteudo,recebido_em,remetente`,
    )) as Msg[];
    for (const m of msgs) {
      const arr = porCard.get(m.card_id) ?? [];
      arr.push(m);
      porCard.set(m.card_id, arr);
    }
  }
  // corta o que chegou depois da decisão — o agente não teria visto
  const decisaoPorCard = new Map(casos.map((c) => [c.card_id, c.decidido_em]));
  for (const [cardId, msgs] of porCard) {
    const corte = decisaoPorCard.get(cardId);
    porCard.set(
      cardId,
      corte ? msgs.filter((m) => (m.recebido_em ?? "") < corte) : msgs,
    );
  }
  return porCard;
}

interface Resultado {
  total: number;
  comEmail: number;
  disparou: number;
  exemplos: { nf: string | null; padrao: string | null; trecho: string | null }[];
}

async function avaliar(casos: Caso[], maxExemplos: number): Promise<Resultado> {
  const porCard = await mensagensAntesDaDecisao(casos);
  const r: Resultado = { total: casos.length, comEmail: 0, disparou: 0, exemplos: [] };
  for (const c of casos) {
    const msgs = porCard.get(c.card_id) ?? [];
    if (msgs.length > 0) r.comEmail++;
    const d = detectarDevolucaoNasMensagens(msgs);
    if (d.solicitada) {
      r.disparou++;
      if (r.exemplos.length < maxExemplos) {
        r.exemplos.push({ nf: c.nf, padrao: d.padrao, trecho: (d.trecho ?? "").slice(0, 90) });
      }
    }
  }
  return r;
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`;
}

// --------------------------------- run -------------------------------------

console.log("================================================================");
console.log("CALIBRAÇÃO — detector de devolução por e-mail (oc 10, capacidade A)");
console.log("----------------------------------------------------------------");

const bolsao = await buscarCasos(["veredito=eq.corrigida", "oc_executada=eq.44"], 200);
const controle = await buscarCasos(["veredito=eq.seguida", "oc_sugerida=eq.54"], 900);

const rb = await avaliar(bolsao, 5);
const rc = await avaliar(controle, 5);

console.log(`BOLSÃO (time corrigiu pra 44): ${rb.total} casos · ${rb.comEmail} com e-mail antes`);
console.log(`  detector disparou: ${rb.disparou}  → RECALL ${pct(rb.disparou, rb.total)}`);
console.log(`  (sobre os que tinham e-mail: ${pct(rb.disparou, rb.comEmail)})`);
if (rb.exemplos.length) {
  console.log("  exemplos recuperados:");
  for (const e of rb.exemplos) console.log(`    NF ${e.nf} [${e.padrao}] "${e.trecho}"`);
}

console.log(`CONTROLE (agente acertou com 54): ${rc.total} casos · ${rc.comEmail} com e-mail antes`);
console.log(`  detector disparou: ${rc.disparou}  → FALSO POSITIVO ${pct(rc.disparou, rc.total)}`);
if (rc.exemplos.length) {
  console.log("  exemplos que MUDARIAM (revisar um a um):");
  for (const e of rc.exemplos) console.log(`    NF ${e.nf} [${e.padrao}] "${e.trecho}"`);
}

console.log("----------------------------------------------------------------");
const fpPct = rc.total === 0 ? 0 : (rc.disparou / rc.total) * 100;
const recallPct = rb.total === 0 ? 0 : (rb.disparou / rb.total) * 100;
// Critério: recuperar mais do que estraga, em números absolutos.
const ganhoLiquido = rb.disparou - rc.disparou;
console.log(
  `VEREDITO: recall ${recallPct.toFixed(1)}% · falso positivo ${fpPct.toFixed(1)}% · ` +
    `ganho líquido ${ganhoLiquido > 0 ? "+" : ""}${ganhoLiquido} casos`,
);
console.log(
  ganhoLiquido > 0
    ? "  ➜ recupera mais do que estraga — seguir pra integração."
    : "  ➜ NÃO integrar: estraga tanto ou mais do que recupera.",
);
