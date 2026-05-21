// Horário comercial BRT — seg-sex 8h-18h estrito, sem feriado nacional (MVP).
// BRT fixo -03:00 (Sal Express sem DST conforme convenção projeto).
// Caso âncora: NF 132682 — oc=13 lançada 18h03 seg → false (fora horário).

export function isHorarioComercialBRT(isoDate: string | Date): boolean {
  const d = typeof isoDate === "string" ? new Date(isoDate) : isoDate;
  if (isNaN(d.getTime())) return false;
  const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const dow = brt.getUTCDay(); // 0=Dom..6=Sáb
  const hour = brt.getUTCHours();
  const isWeekday = dow >= 1 && dow <= 5;
  const isCommercialHour = hour >= 8 && hour < 18;
  return isWeekday && isCommercialHour;
}
