// =============================================================================
// ssw-data-hora.ts — FONTE ÚNICA do parser de timestamp de ocorrência do SSW.
//
// O SSW serve a inclusão de cada ocorrência como "DD/MM/YY HH:MM" em horário de
// Brasília (BRT -03, sem DST). Antes este parser estava DUPLICADO (idêntico) em
// confirmar-acao-executada-ssw.ts e email-threading.ts (Caio 2026-06-15) — risco
// de drift. Consolidado aqui (Caio 2026-06-25, raiz NF 346778) pra ser reusado
// também pelo discriminador de reabertura por VERDADE-DO-SSW-POR-HORA.
//
// Módulo PURO, sem dependências — pode ser importado tanto pelo client de baixo
// nível (ssw-internal-client) quanto pelas regras (lag-lancamento-54) sem ciclo.
// =============================================================================

/**
 * Converte "DD/MM/YY HH:MM" (BRT) pra epoch ms UTC. Retorna null se não casar o
 * formato — inclusive quando vem SÓ a data (sem hora): a regex exige hora, então
 * date-only → null (cai no "indefinido" do caller, nunca em 0/agora).
 */
export function parseSswDataHoraBrt(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]);
  const hh = Number(m[4]), mi = Number(m[5]);
  // BRT (-03) → UTC: soma 3h ao montar o epoch.
  return Date.UTC(2000 + yy, mm - 1, dd, hh + 3, mi);
}
