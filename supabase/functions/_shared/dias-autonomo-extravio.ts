// Limiar (dia útil) a partir do qual o agente-extravio-d4 lança a oc 49 autônoma.
// Duílio 2026-07-28: era hardcoded D4 pra todos; virou config por operador
// (default 4) + override por cliente. Migration 2026-07-28_313.
//
// Precedência (mais específico vence): cliente > operador > default(4).
// O piso configurável é 2 (D2) — casado com o CHECK (2..30) da migration e com
// o fetch do agente (dias_uteis >= MIN_DIA_AUTONOMO_EXTRAVIO). Baixar disso exige
// mexer nos DOIS lugares.

export const DEFAULT_DIAS_AUTONOMO_EXTRAVIO = 4;
export const MIN_DIA_AUTONOMO_EXTRAVIO = 2;

/**
 * Resolve o limiar de dias úteis pra um card: cliente > operador > default(4).
 * NULL/undefined = "sem valor nesse nível" (cai pro próximo).
 */
export function resolverDiasAutonomoExtravio(
  diasOperador: number | null | undefined,
  diasCliente: number | null | undefined,
): number {
  if (diasCliente != null) return diasCliente;
  if (diasOperador != null) return diasOperador;
  return DEFAULT_DIAS_AUTONOMO_EXTRAVIO;
}

/** true quando o card já atingiu o limiar (dias_uteis >= limiar). */
export function elegivelLancamento49Autonomo(
  diasUteis: number | null | undefined,
  limiar: number,
): boolean {
  return diasUteis != null && diasUteis >= limiar;
}
