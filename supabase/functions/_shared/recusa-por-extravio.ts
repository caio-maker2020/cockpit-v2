// =============================================================================
// Detector: recusa/falta no destino (oc 10/19/35) ORIGINADA de extravio anterior
// (oc 6/9/16) que o cliente ainda NÃO foi notificado.
//
// Caio 2026-06-24 (NF 148558): sequência oc=6 (extravio) → operação mandou pra
// entrega → oc=10 (recusa) "não recebe faltando volume". A recusa foi causada
// pelo extravio. Regra do Caio: existe 6/9/16 E NÃO existe 20/54/49 lançada
// DEPOIS do extravio (= operador ainda não notificou o cliente da falta).
// Nesse caso o agente sugere o e-mail combinado (devolver x seguir + romaneio +
// descrição + valor) e sinaliza o conflito de contexto pro operador.
//
// Fonte ÚNICA da regra — consumida pelo agente-sugere-ocs-padrao. Função pura,
// testável (recusa-por-extravio.test.ts).
// =============================================================================

/** Ocorrências de extravio que originam a recusa. */
export const OCS_EXTRAVIO = new Set<number>([6, 9, 16]);

/**
 * Ocorrências cuja presença DEPOIS do extravio indica que o cliente já foi
 * notificado / o relacionamento já assumiu a tratativa.
 *   20 = relacionamento, 54 = aguardando cliente, 49 = tratativa relacionamento.
 */
export const OCS_NOTIFICOU_APOS_EXTRAVIO = new Set<number>([20, 54, 49]);

export interface OcComCodigo {
  codigo: number | null;
}

/**
 * Retorna a ocorrência de extravio (6/9/16) quando há extravio no histórico E
 * NÃO há 20/54/49 lançada depois dele; senão null.
 *
 * `historico` deve vir MAIS-RECENTE-PRIMEIRO (como o puxar-historico-ssw-card
 * devolve). "Lançada depois do extravio" = índice MENOR que o do extravio.
 */
export function recusaOriginadaDeExtravioNaoNotificada<T extends OcComCodigo>(
  historico: T[],
): T | null {
  const idxExtravio = historico.findIndex(
    (o) => o.codigo != null && OCS_EXTRAVIO.has(o.codigo),
  );
  if (idxExtravio === -1) return null;
  for (let i = 0; i < idxExtravio; i++) {
    const c = historico[i]?.codigo;
    if (c != null && OCS_NOTIFICOU_APOS_EXTRAVIO.has(c)) return null; // já notificou
  }
  return historico[idxExtravio] ?? null;
}
