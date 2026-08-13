// Agenda do robô-intranet Würth. Espelha o cron `robo-intranet-wurth-2x-dia`
// (`0 11,19 * * *` UTC = 08h/16h BRT). O Brasil não tem horário de verão desde
// 2019 → America/Sao_Paulo é UTC-3 FIXO, então computamos em UTC e rotulamos BRT
// (sem depender do fuso do navegador do operador).

/** Horas UTC em que o cron dispara: 11 = 08h BRT, 19 = 16h BRT. */
const FIRES_UTC_HORAS = [11, 19] as const;
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

export interface ProximaVarredura {
  /** Instante absoluto (UTC) da próxima varredura agendada. */
  at: Date;
  /** Rótulo em BRT: "hoje 16:00" | "amanhã 08:00". */
  label: string;
}

/** Chave numérica AAAAMMDD do dia em BRT (robusto a virada de mês). */
function diaBrt(d: Date): number {
  const b = new Date(d.getTime() - BRT_OFFSET_MS);
  return b.getUTCFullYear() * 10000 + (b.getUTCMonth() + 1) * 100 + b.getUTCDate();
}

/**
 * Próxima varredura estritamente após `now`. Como o maior intervalo entre
 * disparos é 16h (16h→08h), a próxima é sempre "hoje" ou "amanhã" em BRT.
 */
export function proximaVarreduraWurth(now: Date): ProximaVarredura {
  const candidatos: Date[] = [];
  for (const off of [0, 1, 2]) {
    for (const h of FIRES_UTC_HORAS) {
      candidatos.push(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + off, h, 0, 0, 0)),
      );
    }
  }
  const at = candidatos.find((d) => d.getTime() > now.getTime())!;
  const horaBrt = (at.getUTCHours() + 24 - 3) % 24; // 11→08, 19→16
  const quando = diaBrt(at) === diaBrt(now) ? "hoje" : "amanhã";
  return { at, label: `${quando} ${String(horaBrt).padStart(2, "0")}:00` };
}
