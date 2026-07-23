// =============================================================================
// FONTE ÚNICA: "resposta real de cliente acorda este card?" (Caio 2026-07-23,
// NF 73220 LARISSA — romaneio respondido caiu em card TRANSFERIDO e ficou MUDO
// por 7 dias).
//
// REGRA INVIOLÁVEL (INV-016 estendido): resposta REAL de cliente NUNCA é muda.
// Card em estado terminal (TRANSFERIDO/RESOLVIDO) REABRE — a palavra do cliente
// vale mais que a verdade do Bastão.
//
// Por que existe: o vinculador tinha DUAS cópias divergentes dessa decisão
// (caminho por thread ~l.258 e caminho por NF ~l.427). No caminho por thread,
// card terminal era silenciosamente ignorado; no por NF, o ramo de reabertura
// foi SUSPENSO em 2026-05-12 apostando que "o sync reabre" — aposta anulada em
// 2026-06-25 pelo guard de IDENTIDADE (ADR 0011: última oc do SSW é nossa →
// NÃO reabre). Os dois juntos = beco sem saída: NF 73220 teve 83 supressões de
// reabertura em 7 dias enquanto o cliente cobrava. Detalhe da gênese: o card
// só estava TRANSFERIDO por causa da regressão pré-59 do confirmador
// (corrigida na regularização de 2026-07-22), mas o buraco de design vale pra
// QUALQUER card terminal com cliente vivo.
//
// Bounce/DSN nunca chega aqui: filtrado no gmail-poll-inbox (ehBounce, NF 5826).
// EXTRAVIO_MONITORADO fica fora de propósito: card parked na aba Extravios tem
// reconciliação própria (INV-017); reabrir por resposta ali é decisão separada.
// =============================================================================

/** Estados terminais que uma resposta real de cliente REABRE. */
export const STATES_TERMINAIS_REABERTOS_POR_RESPOSTA: ReadonlyArray<string> = [
  "TRANSFERIDO",
  "RESOLVIDO",
];

export type AcionamentoResposta =
  | { acao: "acionar"; reabre: boolean }
  | { acao: "ignorar"; motivo: string };

/**
 * Decide o efeito de uma resposta real de cliente sobre o card.
 *
 * @param state estado atual do card no momento da resposta.
 * @param tinhaClienteRespondeu `cards.cliente_respondeu_em != null` — só é
 *   relevante quando state=AGUARDANDO_VALIDACAO_HUMANA (re-resposta em card
 *   já na aba CLIENTE RESPONDEU re-aciona a IA; AVH "normal" não).
 */
export function decidirAcionamentoPorRespostaCliente(
  state: string | null | undefined,
  tinhaClienteRespondeu: boolean,
): AcionamentoResposta {
  if (state === "AGUARDANDO_CLIENTE" || state === "ACAO_EXECUTADA") {
    return { acao: "acionar", reabre: false };
  }
  if (state === "AGUARDANDO_VALIDACAO_HUMANA") {
    return tinhaClienteRespondeu
      ? { acao: "acionar", reabre: false }
      : {
        acao: "ignorar",
        motivo:
          "AVH sem cliente_respondeu_em — card já tem propostas pendentes por outro motivo",
      };
  }
  if (state != null && STATES_TERMINAIS_REABERTOS_POR_RESPOSTA.includes(state)) {
    return { acao: "acionar", reabre: true };
  }
  return {
    acao: "ignorar",
    motivo: `state ${state ?? "null"} fora do acionamento por resposta de cliente`,
  };
}
