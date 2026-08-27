// Guard INV-115 (Caio 27/08): countdown VIVO do board — mm:ss por segundo
// abaixo de 1h (o operador vê regredir sem abrir o card).
import { describe, expect, it } from "vitest";
import { rotuloCountdownVivo } from "./acaoAutonomaVeto";

describe("rotuloCountdownVivo", () => {
  const agora = new Date("2026-08-27T15:00:00Z").getTime();
  const em = (seg: number) => new Date(agora + seg * 1000).toISOString();

  it("abaixo de 1h: mm:ss regressivo por segundo", () => {
    expect(rotuloCountdownVivo(em(50 * 60), agora)).toBe("50:00");
    expect(rotuloCountdownVivo(em(50 * 60 - 1), agora)).toBe("49:59");
    expect(rotuloCountdownVivo(em(61), agora)).toBe("1:01");
    expect(rotuloCountdownVivo(em(59), agora)).toBe("0:59");
  });

  it("vencido: executando…; nulo: —", () => {
    expect(rotuloCountdownVivo(em(0), agora)).toBe("executando…");
    expect(rotuloCountdownVivo(em(-30), agora)).toBe("executando…");
    expect(rotuloCountdownVivo(null, agora)).toBe("—");
  });

  it("acima de 1h: cai no formato 'vence hh:mm' (sem falso mm:ss gigante)", () => {
    expect(rotuloCountdownVivo(em(2 * 3600), agora)).toMatch(/^vence /);
  });
});
