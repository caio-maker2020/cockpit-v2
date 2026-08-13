// =============================================================================
// backfill_instrucao_wurth_70.ts — reescreve a instrução das propostas oc 21 do
// robô Würth que ainda carregam o boilerplate de 55 chars (Caio 2026-08-13).
//
// Por que script e não migration SQL: a compressão é a MESMA função que o robô
// usa em produção (`comprimirInstrucaoWurth`). Reimplementar as regras em regex
// de Postgres criaria duas verdades — o teste garantiria uma e o backfill
// aplicaria outra. Aqui há uma fonte só.
//
// Alcance: SÓ propostas PENDENTES (as já lançadas não dá pra editar no SSW).
// Idempotente: pula o que já tem `meta.obs_intranet_original` (já migrado).
//
//   deno run --allow-env --allow-net scripts/backfill_instrucao_wurth_70.ts --dry-run
//   deno run --allow-env --allow-net scripts/backfill_instrucao_wurth_70.ts --apply
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { comprimirInstrucaoWurth } from "../supabase/functions/_shared/instrucao-ssw-wurth.ts";

const APLICAR = Deno.args.includes("--apply");
const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no ambiente");
  Deno.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

type Todo = { id: string; card_id: string; proposta_payload: Record<string, unknown> };

// Filtro NO SERVIDOR: `todos` tem ~15k pendentes e o PostgREST devolve no
// máximo 1000 por página — puxar tudo e filtrar no cliente perdia os alvos
// silenciosamente (pego no dry-run: "0 propostas" com 2 existindo).
const { data: todos, error } = await supabase
  .from("todos")
  .select("id, card_id, proposta_payload")
  .in("status", ["pendente", "aguardando_aprovacao"])
  .eq("proposta_payload->>acao_key", "lancar_ocorrencia:21")
  .eq("proposta_payload->meta->>origem", "robo-intranet-wurth");
if (error) {
  console.error("erro lendo todos:", error.message);
  Deno.exit(1);
}

const alvos = ((todos ?? []) as Todo[]).filter((t) => {
  const meta = ((t.proposta_payload ?? {})["meta"] ?? {}) as Record<string, unknown>;
  return !meta["obs_intranet_original"]; // já migrado = pula
});

console.log(`propostas oc21 do robô pendentes a migrar: ${alvos.length}`);
let ok = 0, semObs = 0, jaNoSsw = 0;

for (const t of alvos) {
  // A Obs original vive no dedupe (o payload antigo só tem o texto com prefixo).
  const { data: ret } = await supabase
    .from("wurth_retornos_processados")
    .select("nf, observacao")
    .eq("card_id", t.card_id)
    .ilike("solucao", "%reentrega%")
    .order("data_solucao", { ascending: false })
    .limit(1)
    .maybeSingle();

  const obs = (ret as { observacao?: string } | null)?.observacao ?? "";
  const nf = (ret as { nf?: string } | null)?.nf ?? "?";
  if (!obs.trim()) {
    semObs++;
    console.log(`  NF ${nf}: sem Obs guardada — pulado`);
    continue;
  }

  // TRAVA (Caio 2026-08-13): se a oc 21 JÁ foi lançada no SSW, "já era" — não
  // se reescreve proposta de algo que já saiu. `status` não serve de prova
  // (pode mudar por outro caminho); a fonte da verdade é acoes_executadas_ssw.
  const { count: jaLancou } = await supabase
    .from("acoes_executadas_ssw")
    .select("id", { count: "exact", head: true })
    .eq("card_id", t.card_id)
    .eq("codigo_oc", 21);
  if ((jaLancou ?? 0) > 0) {
    jaNoSsw++;
    console.log(`  NF ${nf}: oc21 JÁ lançada no SSW — não mexer`);
    continue;
  }

  const pp = t.proposta_payload;
  const antes = String((pp["args"] as Record<string, unknown>)?.["descricao"] ?? "");
  const texto = comprimirInstrucaoWurth(obs);
  console.log(`  NF ${nf}`);
  console.log(`    antes : ${antes.slice(0, 70)}`);
  console.log(`    depois: ${texto}  [${texto.length}]`);

  if (!APLICAR) continue;

  const novo = {
    ...pp,
    texto,
    args: { ...(pp["args"] as Record<string, unknown> ?? {}), descricao: texto },
    meta: {
      ...(pp["meta"] as Record<string, unknown> ?? {}),
      texto_ssw_sugerido: texto,
      obs_intranet_original: obs,
    },
  };
  const { error: errUpd } = await supabase
    .from("todos").update({ proposta_payload: novo }).eq("id", t.id);
  if (errUpd) {
    console.error(`    ERRO: ${errUpd.message}`);
    continue;
  }
  await supabase.from("card_events").insert({
    card_id: t.card_id,
    event_type: "InstrucaoWurthRecomprimida",
    actor_type: "system",
    actor_id: "backfill_instrucao_wurth_70",
    payload: { nf, todo_id: t.id, antes, depois: texto, obs_original: obs },
  });
  ok++;
}

console.log(
  APLICAR
    ? `\nAPLICADO: ${ok} atualizada(s), ${semObs} sem Obs, ${jaNoSsw} já no SSW (intocadas).`
    : `\nDRY-RUN (nada gravado): ${jaNoSsw} já no SSW seriam puladas. Rode com --apply pra valer.`,
);
