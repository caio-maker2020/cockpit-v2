// =============================================================================
// fila-acoes-agendadas — decisão pura de retry pra ações agendadas que falham.
//
// INV-fila (fix 2026-07-16, fila saturada): toda ação em `acoes_agendadas` que
// falha OU avança `executar_em` pro futuro OU muda pra estado ≠ 'pendente'.
// PROIBIDO falhar e manter `executar_em` no passado — foi isso que deixou 200+
// cobranca_email eternas na frente da janela `ORDER BY executar_em ASC LIMIT
// 200` e starvou os cancelar_reentrega_ssw (posições 203–225 em 16/07/2026).
//
// Módulo puro (sem imports) de propósito: testável com `deno test` sem mock.
// =============================================================================

export const MAX_TENTATIVAS_COBRANCA = 5;
export const DELAY_REAGENDAMENTO_HORAS = 24;

export type ProximoPassoFalhaCobranca =
  | {
    acao: "reagendar";
    novaTentativa: number;
    delayHoras: number;
  }
  // Terminal = 'cancelado' + alerta em `alerts` (review 2026-07-17: NÃO usar
  // 'precisa_acao' pra cobranca_email — todos os consumidores desse status
  // (view v_cancelamentos_reentrega, telas, forcar-cancelamento-reentrega)
  // filtram tipo='cancelar_reentrega_ssw', então a ação ficaria invisível e o
  // cancelar_acoes_agendadas_do_card, que só toca 'pendente', nunca a limparia.
  | { acao: "falha_definitiva"; tentativasTotais: number };

/**
 * Decide o que fazer com uma cobranca_email que falhou (sem contato / sem
 * template). Nunca devolve "manter pendente onde está" — ou reagenda pro
 * futuro, ou encerra em estado terminal com alerta visível.
 */
export function decidirProximoPassoFalhaCobranca(
  tentativasAtuais: number,
  maxTentativas: number = MAX_TENTATIVAS_COBRANCA,
): ProximoPassoFalhaCobranca {
  const novaTentativa = tentativasAtuais + 1;
  if (novaTentativa >= maxTentativas) {
    return { acao: "falha_definitiva", tentativasTotais: novaTentativa };
  }
  // Nota: o evento CobrancaAdiadaSem* sai SÓ na 1ª falha (anti-spam ~19k/dia
  // da saturação de 07/2026), mas quem controla isso é o handler, via flag
  // `evento_primeira_falha_registrado` no payload — persistida, sobrevive a
  // insert transiente que falhou (review R2/R3).
  return {
    acao: "reagendar",
    novaTentativa,
    delayHoras: DELAY_REAGENDAMENTO_HORAS,
  };
}

/**
 * Checa o INV-fila pra um par (antes, depois) de uma ação que FALHOU.
 * true = viola (ficou pendente sem avançar executar_em — pendência eterna).
 */
export function violaInvFila(
  antes: { status: string; executar_em: string },
  depois: { status: string; executar_em: string },
): boolean {
  if (depois.status !== "pendente") return false;
  return Date.parse(depois.executar_em) <= Date.parse(antes.executar_em);
}
