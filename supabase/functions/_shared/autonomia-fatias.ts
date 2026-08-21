// =============================================================================
// autonomia-fatias — o FIO que liga o cofre de autonomia aos agentes
// (Caio 2026-08-21, rodada 2 da máquina de visão: "fazer os 95% autônomos").
//
// Fluxo: agente destaca a recomendação → este helper pergunta ao cofre
// (fatia_esta_autonoma, mig 340 — default FALSE) se a fatia
// agente × oc-do-card × oc-sugerida foi promovida pelo botão ⚡ da Gestão
// Agentes → se sim (e SÓ se todas as travas passarem), chama
// auto_aprovar_e_executar (mig 021): aprovação sem humano, evento
// AutoAprovacaoPermitida, todos.auto_approval_rule rastreável.
//
// CAMADAS DE SEGURANÇA (todas precisam passar):
//   1. flag master `autonomia_fatias_enabled` (nasce OFF — kill-switch sem deploy);
//   2. fatia promovida no cofre (⚡ manual do Caio, régua 95%/50 pares);
//   3. oc na lista SEGURA (21/44/54/59) — 56 e afins exigem INPUT humano e
//      jamais auto-aprovam, mesmo se alguém promover a fatia por engano;
//   4. todo PENDENTE com a MESMA acao_key destacada (nada de aprovar outra ação);
//   5. qualquer erro → silêncio e o card segue pro operador (fail-safe).
//
// Kill-switch de qualidade: cron diário roda demover_fatias_abaixo_da_meta()
// (histerese: promove ≥95, despromove <90 — mig 340/348).
//
// PLACAR HONESTO: execução auto-aprovada NÃO gera feedback implícito
// "seguida" (o agente não se autoavalia) — guard no executor, mesma rodada.
// =============================================================================

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

const FLAG_MASTER = "autonomia_fatias_enabled";

/** Ocs que podem executar sem humano: ações completas, sem input do operador.
 *  56 (falta info) e 41 exigem texto do operador — fora, SEMPRE. */
const OCS_SEGURAS_AUTONOMIA: ReadonlySet<number> = new Set([21, 44, 54, 59]);

/** Guard PURO (testável): a fatia é elegível a auto-aprovação? */
export function podeAutoAprovarFatia(
  ocSugerida: number | null,
  acaoKey: string | null,
): boolean {
  if (ocSugerida == null || !OCS_SEGURAS_AUTONOMIA.has(ocSugerida)) return false;
  if (!acaoKey) return false;
  // só as duas famílias de ação completas — nada de combos/modais/inputs
  return /^(lancar_ocorrencia|lancar_oc_e_enviar_email):\d+$/.test(acaoKey);
}

export function montarRegraAutonomia(
  agentName: string,
  ocCard: number | null,
  ocSugerida: number,
): string {
  return `fatia_autonoma:${agentName}:oc${ocCard ?? "sem"}->${ocSugerida}`;
}

export type ResultadoAutonomia =
  | "auto_aprovado"
  | "flag_off"
  | "fatia_nao_autonoma"
  | "oc_nao_segura"
  | "todo_nao_encontrado"
  | "erro";

/**
 * Tenta auto-aprovar o todo destacado quando a fatia está no cofre.
 * NUNCA lança (erro → "erro" e o fluxo normal de aprovação humana segue).
 */
export async function autoAprovarSeFatiaAutonoma(
  supabase: SupabaseClient,
  i: {
    cardId: string;
    agentName: string;
    ocCard: number | null;
    ocSugerida: number | null;
    acaoKey: string | null;
  },
): Promise<ResultadoAutonomia> {
  try {
    if (!podeAutoAprovarFatia(i.ocSugerida, i.acaoKey)) return "oc_nao_segura";

    const { data: flagRow } = await supabase
      .from("feature_flags").select("enabled").eq("key", FLAG_MASTER).maybeSingle();
    if ((flagRow as { enabled?: boolean } | null)?.enabled !== true) return "flag_off";

    const { data: autonoma } = await supabase.rpc("fatia_esta_autonoma", {
      p_agent_name: i.agentName,
      p_oc_card: i.ocCard,
      p_oc_sugerida: i.ocSugerida,
    });
    if (autonoma !== true) return "fatia_nao_autonoma";

    // o todo PENDENTE com exatamente a acao_key destacada (o mais recente)
    const { data: todos } = await supabase
      .from("todos")
      .select("id, proposta_payload, status")
      .eq("card_id", i.cardId)
      .eq("status", "pendente")
      .order("created_at", { ascending: false })
      .limit(20);
    const alvo = ((todos ?? []) as Array<{ id: string; proposta_payload: { acao_key?: string } | null }>)
      .find((t) => t.proposta_payload?.acao_key === i.acaoKey);
    if (!alvo) return "todo_nao_encontrado";

    const regra = montarRegraAutonomia(i.agentName, i.ocCard, i.ocSugerida!);
    const { error } = await supabase.rpc("auto_aprovar_e_executar", {
      p_todo_id: alvo.id,
      p_regra: regra,
    });
    if (error) {
      console.warn(`[autonomia-fatias] auto_aprovar falhou (${regra}): ${error.message} — segue pro operador`);
      return "erro";
    }
    console.log(`[autonomia-fatias] AUTO-APROVADO card=${i.cardId} ${regra} todo=${alvo.id}`);
    return "auto_aprovado";
  } catch (e) {
    console.warn(`[autonomia-fatias] erro isolado: ${e instanceof Error ? e.message : String(e)} — segue pro operador`);
    return "erro";
  }
}
