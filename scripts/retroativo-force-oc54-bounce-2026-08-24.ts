// =============================================================================
// RETROATIVO do bounce force-oc54 (Caio 2026-08-24, NF 1611059).
//
// Classe: cards em AGUARDANDO_CLIENTE cujo ÚLTIMO lançamento bem-sucedido do
// Cockpit foi oc ≠54/59 (o force com Bastão stale arrastou de volta) e SEM
// resposta de cliente / nova aprovação depois do lançamento. Medido 24/08:
// até 408 cards (30d).
//
// Estratégia: NÃO decide nada localmente — chama a edge
// `atualizar-card-via-portal-ssw` (a mesma do botão "↻ atualizar agora") pra
// cada candidato. Ela consulta o SSW real e aplica as regras de produção:
//   finalizadora (1/30/32) → RESOLVIDO · fora de relacionamento → TRANSFERIDO
//   relacionamento ≠ atual → AGUARDANDO VOCÊ · igual → ja_atualizado (no-op).
// Tudo com eventos em card_events (auditável card a card).
//
// USO (só com autorização expressa do Caio — mexe em cards de produção):
//   deno run --allow-net --allow-env scripts/retroativo-force-oc54-bounce-2026-08-24.ts --dry-run
//   deno run --allow-net --allow-env scripts/retroativo-force-oc54-bounce-2026-08-24.ts --executar
// Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (do .env.local).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const url = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("VITE_SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no env.");
  Deno.exit(1);
}
const executar = Deno.args.includes("--executar");
if (!executar && !Deno.args.includes("--dry-run")) {
  console.error("Passe --dry-run (lista) ou --executar (com autorização do Caio).");
  Deno.exit(1);
}

const supabase = createClient(url, key);

// Candidatos: mesma régua da medição de 24/08 (última ação Cockpit ≠54/59 nos
// últimos 45d, ainda AGUARDANDO_CLIENTE, sem resposta/aprovação posterior).
const { data: rows, error: qErr } = await supabase
  .from("cards")
  .select("id, nf, state, cod_ultima_ocorrencia")
  .eq("state", "AGUARDANDO_CLIENTE");
if (qErr) throw qErr;

const elegiveis: Array<{ id: string; nf: string }> = [];
for (const c of rows ?? []) {
  const { data: ult } = await supabase
    .from("acoes_executadas_ssw")
    .select("codigo_oc, iniciado_em")
    .eq("card_id", c.id)
    .eq("sucesso", true)
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  const u = ult as { codigo_oc?: number; iniciado_em?: string } | null;
  if (!u?.iniciado_em || u.codigo_oc == null) continue;
  if (u.codigo_oc === 54 || u.codigo_oc === 59) continue; // fluxo normal
  const idade = Date.now() - new Date(u.iniciado_em).getTime();
  if (idade > 45 * 24 * 60 * 60 * 1000) continue;
  const { count } = await supabase
    .from("card_events")
    .select("id", { count: "exact", head: true })
    .eq("card_id", c.id)
    .in("event_type", ["RespostaClienteCapturada", "AprovacaoOperador"])
    .gt("created_at", u.iniciado_em);
  if ((count ?? 0) > 0) continue; // teve movimento humano/cliente depois — não mexer
  elegiveis.push({ id: c.id as string, nf: c.nf as string });
}

console.log(`${elegiveis.length} cards elegíveis.`);
if (!executar) {
  for (const e of elegiveis) console.log(`  NF ${e.nf} (${e.id})`);
  console.log("Dry-run — nada alterado. Rode com --executar após autorização do Caio.");
  Deno.exit(0);
}

let ok = 0, falha = 0;
const porDecisao = new Map<string, number>();
for (const [i, e] of elegiveis.entries()) {
  try {
    const r = await supabase.functions.invoke("atualizar-card-via-portal-ssw", {
      body: { card_id: e.id },
    });
    const d = (r.data as { decisao?: string } | null)?.decisao ?? (r.error ? "erro" : "sem_decisao");
    porDecisao.set(d, (porDecisao.get(d) ?? 0) + 1);
    if (r.error) { falha++; console.warn(`  NF ${e.nf}: ${r.error.message}`); }
    else { ok++; console.log(`  [${i + 1}/${elegiveis.length}] NF ${e.nf}: ${d}`); }
  } catch (err) {
    falha++;
    console.warn(`  NF ${e.nf}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\nFim: ${ok} ok, ${falha} falhas. Decisões:`, Object.fromEntries(porDecisao));
