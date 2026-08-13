// =============================================================================
// feedback-implicito-agentes.ts — o par "agente sugeriu X · operador fez Y".
//
// DEFINIÇÃO CANÔNICA (Caio 2026-08-13): o operador é a verdade.
//   sugeriu X · operador fez X → ACERTO
//   sugeriu X · operador fez Y → ERRO
// É esse par que alimenta o placar dos agentes e o loop de melhoria.
//
// POR QUE ESTE MÓDULO EXISTE (Fase 0 do placar): as 3 RPCs de feedback só eram
// chamadas no caminho principal do executor (`processOne`). Os handlers de oc 33
// — combo 33+44, oc33 solo portal, e-mail+33 romaneio, e-mail livre+33 — lançam
// no SSW por conta própria e dão `return` ANTES desse ponto. Resultado medido:
// 499 execuções em 60 dias que nunca viraram par. Centralizar aqui garante que
// todo caminho que chega ao SSW com sucesso registre o veredito.
//
// REGRA DE OURO: telemetria NUNCA derruba lançamento. Cada RPC é isolada em
// try/catch — falha vira console.warn e o fluxo segue. As RPCs são idempotentes
// e no-op quando o agente não rodou naquele card.
// =============================================================================

/** As 3 RPCs implícitas, na ordem dos agentes hoje mensuráveis. */
const RPCS_FEEDBACK_IMPLICITO = [
  "registrar_feedback_oc13_implicito",
  "registrar_feedback_ocs_padrao_implicito",
  "registrar_feedback_interpretador_resposta_implicito",
] as const;

/**
 * Registra o veredito implícito de todos os agentes para o card.
 *
 * Chamar SOMENTE depois de o SSW confirmar sucesso — feedback de ação que não
 * aconteceu envenena a métrica.
 *
 * @param supabase client com service_role (as RPCs são SECURITY DEFINER)
 * @param cardId   card que teve a ação aprovada
 * @param codigoSsw código de ocorrência que o operador de fato aprovou
 */
export async function registrarFeedbackImplicitoAgentes(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  cardId: string,
  codigoSsw: number | null | undefined,
): Promise<void> {
  if (!cardId || !Number.isFinite(Number(codigoSsw))) return;
  for (const rpc of RPCS_FEEDBACK_IMPLICITO) {
    try {
      await supabase.rpc(rpc, { p_card_id: cardId, p_codigo_aprovado: Number(codigoSsw) });
    } catch (err) {
      console.warn(`${rpc} (card=${cardId}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
