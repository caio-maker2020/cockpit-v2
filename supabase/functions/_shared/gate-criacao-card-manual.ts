// Gate de criação de card manual quando a última oc do CTRC NÃO é de
// relacionamento (Duílio 2026-07-27, NF 22232).
//
// Contexto: `criar-card-manual` recusava com `ultima_oc_nao_relacionamento`
// quando a última oc estava fora do escopo do Cockpit (ex.: oc 31 = "Aguardando
// agendamento") — o operador não tinha de onde lançar uma oc fora de padrão
// (ex.: oc 44 = "Retorno de carga" após cancelamento do agendamento).
//
// Decisão do Caio (2026-07-27, opção 1): permitir a criação SÓ com uma
// justificativa explícita do operador ("motivo do lançamento fora do padrão").
// O card nasce com `fora_de_padrao: true` + o motivo auditado. Escopo pontual:
// NÃO abre lançamento automático — o card fica AGUARDANDO_VALIDACAO_HUMANA e o
// operador lança a oc pelo fluxo normal de "oc diferente da sugerida".
//
// Blast radius (verificado): card manual com oc fora de relacionamento é INERTE
// ao sync-bastao — todos os passes/sweeps são escopados a ocs de relacionamento
// ou ocs com regra (REGRAS_AUTO_ACAO); oc 31 não entra em nenhum. Não viola
// INV-006 (oc≠54) nem INV-019 (state≠AGUARDANDO_CLIENTE).

/** Mínimo de caracteres pra uma justificativa contar como explícita. */
export const MIN_MOTIVO_FORA_PADRAO = 10;

export type GateCriacaoManual =
  | { permitido: true; foraDePadrao: false }
  | { permitido: true; foraDePadrao: true; motivo: string }
  | { permitido: false; precisaMotivo: true };

/**
 * Decide se a criação manual segue. Separa a checagem de relacionamento (que
 * continua sendo feita por `isOcorrenciaDeRelacionamentoCtx` no caller) da
 * decisão de justificativa:
 *  - oc de relacionamento → segue normal (foraDePadrao=false);
 *  - oc fora de relacionamento + motivo explícito → segue fora de padrão;
 *  - oc fora de relacionamento SEM motivo → recusa (front pede a justificativa).
 */
export function decidirGateCriacaoManual(
  ocEhRelacionamento: boolean,
  motivoForaPadrao: string | null | undefined,
): GateCriacaoManual {
  if (ocEhRelacionamento) return { permitido: true, foraDePadrao: false };

  const motivo = (motivoForaPadrao ?? "").trim();
  if (motivo.length >= MIN_MOTIVO_FORA_PADRAO) {
    return { permitido: true, foraDePadrao: true, motivo };
  }
  return { permitido: false, precisaMotivo: true };
}
