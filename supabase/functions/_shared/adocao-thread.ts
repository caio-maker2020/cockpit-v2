// =============================================================================
// Idempotência da ADOÇÃO de thread pré-existente (scan-email-pre-card).
//
// Incidente 26/07: 15.052 jobs de adoção na fila para apenas 59 cards (campeão:
// 2.504 jobs do mesmo card). `processarAdocaoJob` não checava NADA antes de ir
// ao Gmail — a NF 166229 foi re-importada 105x em um dia (105 movimentações do
// card + 105 recriações de proposta + 111 chamadas de IA), e no ritmo do cron
// (1 job/2min) o desperdício duraria ~21 dias.
//
// Raízes: (1) o produtor enfileira 1 scan por e-mail, sem dedup — 13 dias de
// backlog represado; (2) o dreno de 25/07 (INV-052) converteu esse represamento
// em adoções reais de uma vez. A trava aqui é o CINTO: mesmo com N jobs
// repetidos, só o primeiro trabalha.
//
// Sinal natural de "já adotei": a própria adoção grava
// `cards.tratativa_email_escolhida = threadId` no fim do processamento.
// =============================================================================

/** Estados em que adotar thread não faz sentido (card fora do fluxo vivo). */
export const STATES_TERMINAIS_SEM_ADOCAO: ReadonlyArray<string> = [
  "TRANSFERIDO",
  "RESOLVIDO",
  "CANCELADO",
];

export type DecisaoAdocao =
  | { acao: "adotar" }
  | { acao: "pular"; motivo: string };

export interface CardParaAdocao {
  state?: string | null;
  tratativa_email_escolhida?: string | null;
}

export function decidirAdocaoThread(
  card: CardParaAdocao | null | undefined,
  threadId: string | null | undefined,
): DecisaoAdocao {
  if (!card) return { acao: "pular", motivo: "card inexistente" };
  if (!threadId) return { acao: "pular", motivo: "job sem thread" };

  const state = card.state ?? null;
  if (state != null && STATES_TERMINAIS_SEM_ADOCAO.includes(state)) {
    return { acao: "pular", motivo: `card ${state} — fora do fluxo vivo` };
  }

  // Já adotou ESTA thread: re-importar refaz tudo (move o card, recria
  // propostas, chama IA) sem nenhum ganho — mensagens novas dessa thread
  // chegam pelo gmail-poll → vinculador, que é o caminho normal.
  if (card.tratativa_email_escolhida && card.tratativa_email_escolhida === threadId) {
    return { acao: "pular", motivo: "thread já adotada por este card" };
  }

  return { acao: "adotar" };
}
