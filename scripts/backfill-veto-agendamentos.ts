// =============================================================================
// backfill-veto-agendamentos — roda o AGENDADOR DE PRODUÇÃO sobre o estoque
// atual do cockpit (Caio 26/08: "o backfill precisa rodar em tudo que está
// aparecendo ao operador — já é um banco de testes").
//
// O que faz: para cada card ATIVO em AGUARDANDO_VALIDACAO_HUMANA dos
// operadores do PILOTO, resolve a ação destacada (mesmas fontes do front:
// aviso_alteracao_oc → ia_sugestao → aguardar) e chama
// agendarAcaoAutonomaSeElegivel — o módulo DE PRODUÇÃO, com TODAS as cercas
// (flag master, escada, piloto, conteúdo, ciclo, veto anterior, confiança…).
// Nada aqui decide por conta própria: inelegível = fica manual, com o motivo
// contado no resumo final.
//
// QUANDO RODAR: só APÓS migs aplicadas + deploy + flag master ON + degraus ON
// (ordem nominal do Caio). Com tudo OFF é um no-op que só imprime motivos.
//
// USO:
//   source .env.local
//   deno run --allow-net --allow-env scripts/backfill-veto-agendamentos.ts [--dry]
//   (--dry: só resolve e imprime o que FARIA, sem agendar nada)
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { agendarAcaoAutonomaSeElegivel } from "../supabase/functions/_shared/veto-agendamento.ts";
import { resolverAcaoDestacada, type TodoPendenteResumo } from "../supabase/functions/_shared/destaque-resposta-cliente.ts";

const DRY = Deno.args.includes("--dry");
const url = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("VITE_SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no ambiente (source .env.local)");
  Deno.exit(1);
}
// deno-lint-ignore no-explicit-any
const supabase = createClient(url, key) as any;

const { data: pilotos } = await supabase
  .from("acoes_autonomas_veto_operadores")
  .select("operador_id, ativo, operador:operadores(nome)")
  .eq("ativo", true);
const pilotoIds = ((pilotos ?? []) as Array<{ operador_id: string }>).map((p) => p.operador_id);
console.log(`Piloto: ${((pilotos ?? []) as Array<{ operador?: { nome?: string } }>).map((p) => p.operador?.nome).join(", ")} (${pilotoIds.length})`);
if (pilotoIds.length === 0) {
  console.log("Nenhum operador no piloto (mig 357 aplicada?) — nada a fazer.");
  Deno.exit(0);
}

const { data: cards } = await supabase
  .from("cards")
  .select("id, nf, assigned_operator_id, cod_ultima_ocorrencia, cliente_respondeu_em, aviso_alteracao_oc, ia_sugestao_oc_resposta")
  .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
  .in("assigned_operator_id", pilotoIds);

console.log(`Cards em AGUARDANDO VOCÊ dos pilotos: ${(cards ?? []).length}\n`);

const resumo = new Map<string, number>();
const conta = (k: string) => resumo.set(k, (resumo.get(k) ?? 0) + 1);

for (const card of (cards ?? []) as Array<Record<string, unknown>>) {
  const cardId = card["id"] as string;
  const nf = card["nf"] as string;
  const ocCard = (card["cod_ultima_ocorrencia"] as number | null) ?? null;

  // fontes do destaque — mesma precedência do front
  const aviso = (card["aviso_alteracao_oc"] ?? null) as { tipo?: string; proposta_destacada_acao?: string } | null;
  const ia = (card["ia_sugestao_oc_resposta"] ?? null) as Record<string, unknown> | null;

  let acaoKey: string | null = null;
  let confianca: number | null = null;
  let agente = "backfill-veto";

  if (aviso?.tipo === "ia_sugestao_ocs_padrao" && typeof aviso.proposta_destacada_acao === "string") {
    acaoKey = aviso.proposta_destacada_acao;
    agente = "agente-sugere-ocs-padrao";
  } else if (ia) {
    const { data: todos } = await supabase
      .from("todos").select("id, proposta_payload")
      .eq("card_id", cardId).eq("status", "pendente").limit(30);
    const destaque = resolverAcaoDestacada(
      ia as never, ocCard, (todos ?? []) as TodoPendenteResumo[],
    );
    acaoKey = destaque.acao_key;
    confianca = typeof ia["confianca"] === "number" ? (ia["confianca"] as number) : null;
    agente = "interpretador-resposta-cliente";
  }

  if (!acaoKey) {
    conta("sem_acao_destacada");
    continue;
  }

  if (DRY) {
    console.log(`[dry] NF ${nf}: ${acaoKey} (agente=${agente}, conf=${confianca ?? "—"})`);
    conta(`dry:${acaoKey}`);
    continue;
  }

  const r = await agendarAcaoAutonomaSeElegivel(supabase, {
    cardId,
    agentName: agente,
    acaoKey,
    ocCard,
    ocSugerida: (() => {
      const n = Number(acaoKey!.split(":").pop());
      return Number.isFinite(n) ? n : null;
    })(),
    confianca,
  });
  if (r.agendou) {
    console.log(`AGENDADO  NF ${nf}: ${acaoKey} → executa ${r.executarEm}`);
    conta("agendado");
  } else {
    conta(`barrado:${r.motivo}`);
  }
}

console.log("\n== RESUMO ==");
for (const [k, v] of [...resumo.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(v).padStart(4)}  ${k}`);
}
