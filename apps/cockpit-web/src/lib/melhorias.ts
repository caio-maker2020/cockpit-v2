// Regras puras da fila de melhorias F6 do painel Aprendizado (INV-051).
//
// Incidente 24/07: proposta rejeitada por clique acidental da gestora que
// tinha acabado de responder a pergunta — o card dizia "aguardando SUA
// aprovação" pro próprio autor, sem confirmação nem undo. Estas regras são
// a parte testável do fix; a UI (Aprendizado.tsx) só as consome.

/**
 * Undo só existe pra decisões humanas da fila (aprovado/rejeitado).
 * Estados terminais gravados pelos agentes (aplicado/revertido) e o próprio
 * aberto NUNCA reabrem — mesma regra da RPC reabrir_learning_log (mig 312).
 */
export function podeReabrir(status: string): boolean {
  return status === "aprovado" || status === "rejeitado";
}

/**
 * A proposta nasceu de resposta do gestor logado? Quando sim, a UI mostra o
 * aviso anti-eco ("nasceu da sua resposta — ideal outro gestor revisar") em
 * vez de convidar o autor a decidir no impulso.
 */
export function nasceuDaMinhaResposta(
  autorRespostaId: string | null | undefined,
  operadorId: string | null | undefined,
): boolean {
  return !!autorRespostaId && !!operadorId && autorRespostaId === operadorId;
}

/** Linha da trilha "revisadas recentemente": quem decidiu o quê. */
export function rotuloRevisao(
  status: string,
  revisorNome: string | null | undefined,
  souEu: boolean,
): string {
  const verbo = status === "aprovado" ? "aprovada" : "rejeitada";
  const quem = souEu ? "você" : (revisorNome ?? "outro gestor");
  return `${verbo} por ${quem}`;
}
