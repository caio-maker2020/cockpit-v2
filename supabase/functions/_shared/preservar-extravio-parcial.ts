// =============================================================================
// preservar-extravio-parcial — helper PURO e MÍNIMO (hotfix 2026-07-03).
//
// Objetivo ÚNICO: quando o sync-bastao reconstrói `agent_state` a partir de um
// snapshot fresco do Bastão (que NÃO inclui `extravio_parcial`), o dossiê de
// extravio parcial populado pelo interpretador estava sendo APAGADO no sync
// (NF 1119469/28779 etc.). Este helper preserva a chave `agent_state.extravio_parcial`
// — e SÓ isso.
//
// NÃO classifica caso, NÃO avalia dossiê, NÃO mexe em gate/oc33/state/lock/todo,
// e NÃO importa o módulo do dossiê (que nem existe neste ref). É só preservação
// de chave em agent_state. Testado em preservar-extravio-parcial.test.ts.
// =============================================================================

function temExtravioParcial(state: Record<string, unknown> | null | undefined): boolean {
  const v = state?.["extravio_parcial"];
  return v != null && typeof v === "object";
}

/**
 * Devolve o `snapshot` novo garantindo que a chave `extravio_parcial` não se perca:
 *   - se o snapshot novo JÁ tem `extravio_parcial` → mantém o novo (não sobrescreve);
 *   - senão, se o agent_state EXISTENTE tem → copia a chave pro snapshot;
 *   - se nenhum dos dois tem → devolve o snapshot inalterado.
 * Puro: não muta os argumentos.
 */
export function preservarExtravioParcial(
  snapshot: Record<string, unknown>,
  existingAgentState: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  let out = snapshot;
  if (!temExtravioParcial(snapshot) && temExtravioParcial(existingAgentState)) {
    out = {
      ...out,
      extravio_parcial: (existingAgentState as Record<string, unknown>)["extravio_parcial"],
    };
  }
  // Caio 2026-08-28 (regra v2 da oc43, B4): a marca do relógio original do
  // extravio devolvido pós-manutenção TAMBÉM sobrevive ao snapshot do Bastão
  // (INV-004 emendado) — sem ela o kanban de extravios perde o card e o D4
  // volta a contar da data errada.
  const marca = (existingAgentState as Record<string, unknown> | null | undefined)?.["extravio_retomado_pos43"];
  if (marca != null && (out as Record<string, unknown>)["extravio_retomado_pos43"] == null) {
    out = { ...out, extravio_retomado_pos43: marca };
  }
  return out;
}
