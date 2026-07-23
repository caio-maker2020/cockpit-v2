// =============================================================================
// FONTE ÚNICA: "resposta real de cliente acorda este card?"
//
// PREMISSA DO CAIO (2026-07-23, refinada após NF 73220):
//   1. Cliente respondeu + card ATIVO no Cockpit → o card SE MOVE. Sempre.
//   2. Card TRANSFERIDO/RESOLVIDO NÃO reaparece — transferido = alguém tratou.
//      Resposta nele ANEXA SEM MOVER (visível na aba Mensagens + evento de
//      auditoria; card não volta). Se a NF tiver OUTRO card ativo, a resposta
//      é ROTEADA pra ele (premissa 1 vale pro card vivo da NF) — roteamento
//      feito pelo caller (vinculador), não aqui.
//   3. Card novo criado depois pelas regras de negócio entra na premissa 1.
//
// Histórico: a 1ª versão deste fix (22-23/07) REABRIA card terminal — o Caio
// refinou a regra no mesmo dia: reabrir ressuscitava tratativa já tratada.
// O buraco original (NF 73220: romaneio mudo 7 dias) era um card que SÓ
// estava terminal por regressão (confirmador pré-59, corrigida 22/07);
// com o estado correto (AGUARDANDO_CLIENTE), a premissa 1 já o cobria.
//
// Por que fonte única: o vinculador tinha DUAS cópias divergentes dessa
// decisão (thread × NF) e a divergência criou o buraco. Nunca reimplementar
// inline (INV-042).
//
// Bounce/DSN nunca chega aqui: filtrado no gmail-poll-inbox (ehBounce, NF 5826).
// EXTRAVIO_MONITORADO fora de propósito (reconciliação própria, INV-017).
// =============================================================================

/** Estados terminais: resposta anexa SEM mover (premissa 2). */
export const STATES_TERMINAIS_ANEXA_SEM_MOVER: ReadonlyArray<string> = [
  "TRANSFERIDO",
  "RESOLVIDO",
];

export type AcionamentoResposta =
  | { acao: "acionar" }
  | { acao: "anexar_sem_mover"; motivo: string }
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
    return { acao: "acionar" };
  }
  if (state === "AGUARDANDO_VALIDACAO_HUMANA") {
    return tinhaClienteRespondeu
      ? { acao: "acionar" }
      : {
        acao: "ignorar",
        motivo:
          "AVH sem cliente_respondeu_em — card já tem propostas pendentes por outro motivo",
      };
  }
  if (state != null && STATES_TERMINAIS_ANEXA_SEM_MOVER.includes(state)) {
    return {
      acao: "anexar_sem_mover",
      motivo:
        "card TRANSFERIDO/RESOLVIDO = tratado (premissa 2 do Caio 23/07) — mensagem anexa, card não volta; se houver card ativo da NF, caller roteia pra ele",
    };
  }
  return {
    acao: "ignorar",
    motivo: `state ${state ?? "null"} fora do acionamento por resposta de cliente`,
  };
}
