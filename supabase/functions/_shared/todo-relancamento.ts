// =============================================================================
// Predicado: a proposta nasceu do fluxo pós-resposta com a MESMA oc de
// propósito (relançar = repetir a oc pra renotificar o cliente).
//
// Auditoria 25/07: cancelarTodoSeOcJaLancada (sync-bastao) cancelava 100%
// dos relançamentos pós-resposta como "oc lançada por fora" — o codigo_ssw
// da proposta é POR CONSTRUÇÃO a oc que já está no Bastão, então o filtro
// `codProposto === ocAtualNoBastao` sempre casava (83 todos comidos em 48h;
// NF 158084 ficou sem opções logo depois da resposta do cliente).
// "Lançada por fora" pressupõe que a oc apareceu DEPOIS da proposta — nunca
// vale pra proposta que nasceu conhecendo (e mirando) a oc atual.
// =============================================================================

export function ehPropostaPosRespostaMesmaOc(
  propostaPayload: Record<string, unknown> | null | undefined,
): boolean {
  const meta = propostaPayload?.["meta"] as Record<string, unknown> | undefined;
  if (!meta) return false;
  return (
    meta["tipo_acao"] === "relancamento_54" ||
    meta["origem"] === "vinculador_pos_resposta_cliente"
  );
}
