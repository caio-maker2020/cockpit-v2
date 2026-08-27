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

describe("aviso do almoço (Caio 27/08)", () => {
  // 27/08/2026 BRT: 11:30 = 14:30 UTC
  const brt = (h: number, m: number) => Date.UTC(2026, 7, 27, h + 3, m);
  const iso = (h: number, m: number) => new Date(brt(h, m)).toISOString();

  it("pausaAlmocoAtiva: 12:00–12:59 sim; 11:59/13:00 não", async () => {
    const { pausaAlmocoAtiva } = await import("./acaoAutonomaVeto");
    expect(pausaAlmocoAtiva(brt(12, 0))).toBe(true);
    expect(pausaAlmocoAtiva(brt(12, 59))).toBe(true);
    expect(pausaAlmocoAtiva(brt(11, 59))).toBe(false);
    expect(pausaAlmocoAtiva(brt(13, 0))).toBe(false);
  });

  it("janelaCruzaAlmoco: 11:30→13:30 sim; 10:00→11:00 não; 13:05→14:05 não; durante o almoço sim", async () => {
    const { janelaCruzaAlmoco } = await import("./acaoAutonomaVeto");
    expect(janelaCruzaAlmoco(iso(13, 30), brt(11, 30))).toBe(true);
    expect(janelaCruzaAlmoco(iso(11, 0), brt(10, 0))).toBe(false);
    expect(janelaCruzaAlmoco(iso(14, 5), brt(13, 5))).toBe(false);
    expect(janelaCruzaAlmoco(iso(14, 0), brt(12, 30))).toBe(true);
  });
});
