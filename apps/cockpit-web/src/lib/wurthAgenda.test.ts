import { describe, expect, it } from "vitest";
import { proximaVarreduraWurth } from "./wurthAgenda";

// Cron 0 11,19 UTC = 08h/16h BRT (UTC-3 fixo, sem DST no Brasil).
describe("proximaVarreduraWurth", () => {
  it("de manhã cedo (02h BRT) → próxima é hoje 08:00", () => {
    const r = proximaVarreduraWurth(new Date("2026-08-13T05:00:00Z")); // 02h BRT
    expect(r.label).toBe("hoje 08:00");
    expect(r.at.toISOString()).toBe("2026-08-13T11:00:00.000Z");
  });

  it("meio da manhã (10h BRT, já passou 08h) → próxima é hoje 16:00", () => {
    const r = proximaVarreduraWurth(new Date("2026-08-13T13:00:00Z")); // 10h BRT
    expect(r.label).toBe("hoje 16:00");
    expect(r.at.toISOString()).toBe("2026-08-13T19:00:00.000Z");
  });

  it("fim de tarde (17h BRT, já passou 16h) → próxima é amanhã 08:00", () => {
    const r = proximaVarreduraWurth(new Date("2026-08-13T20:00:00Z")); // 17h BRT
    expect(r.label).toBe("amanhã 08:00");
    expect(r.at.toISOString()).toBe("2026-08-14T11:00:00.000Z");
  });

  it("exatamente às 08:00 BRT → mostra a próxima (16:00), nunca o disparo atual", () => {
    const r = proximaVarreduraWurth(new Date("2026-08-13T11:00:00Z"));
    expect(r.label).toBe("hoje 16:00");
  });

  it("virada de mês: 31/08 17h BRT → amanhã 08:00 (01/09)", () => {
    const r = proximaVarreduraWurth(new Date("2026-08-31T20:00:00Z")); // 31/08 17h BRT
    expect(r.label).toBe("amanhã 08:00");
    expect(r.at.toISOString()).toBe("2026-09-01T11:00:00.000Z");
  });
});
