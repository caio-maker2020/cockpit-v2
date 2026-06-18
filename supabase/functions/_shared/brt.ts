// =============================================================================
// brt — FONTE ÚNICA de horário de Brasília no Cockpit.
//
// O SSW e TODA regra de negócio da Sal Express operam em horário de Brasília
// (BRT = UTC-3 fixo, SEM horário de verão — convenção do projeto). O runtime das
// edge functions roda em UTC, então `new Date()` / `Date.now()` cru dá o dia/hora
// ERRADOS das 21:00 às 23:59 BRT (já é o dia seguinte em UTC). Isso já derrubou
// lançamento no SSW (NF 1505494, busca de NF rejeitada "Data final maior que data
// corrente" às 21h). Use SEMPRE estes helpers pra DIA/HORA/data formatada local.
//
// Regra: nunca formatar data/hora "de hoje" com getUTC*/toISOString direto pra SSW
// ou regra de negócio — passe por aqui. (Caio 2026-06-18)
// =============================================================================

/** Offset fixo BRT (UTC-3), sem DST. */
export const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Date deslocada pra BRT. Leia o dia/hora "de Brasília" com os métodos getUTC*
 * deste objeto (ex.: `nowBRT().getUTCHours()` = hora BRT). NÃO use métodos locais
 * do runtime — eles seriam UTC.
 */
export function nowBRT(epochMs: number = Date.now()): Date {
  return new Date(epochMs - BRT_OFFSET_MS);
}

/** "DDMMYY" em BRT — formato de data do SSW (campos t_data_*, relatórios). */
export function ddmmyyBRT(epochMs: number = Date.now()): string {
  const d = nowBRT(epochMs);
  return (
    String(d.getUTCDate()).padStart(2, "0") +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCFullYear() % 100).padStart(2, "0")
  );
}

/** "YYYY-MM-DD" do dia civil em BRT (chaves de idempotência diária, dedup). */
export function ymdBRT(epochMs: number = Date.now()): string {
  const d = nowBRT(epochMs);
  return (
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")}`
  );
}

/** "HH:MM" em BRT (exibição pra operadora). */
export function hhmmBRT(epochMs: number = Date.now()): string {
  const d = nowBRT(epochMs);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Hora 0-23 em BRT. */
export function horaBRT(epochMs: number = Date.now()): number {
  return nowBRT(epochMs).getUTCHours();
}

/** Dia da semana em BRT (0=Dom .. 6=Sáb). */
export function diaSemanaBRT(epochMs: number = Date.now()): number {
  return nowBRT(epochMs).getUTCDay();
}
