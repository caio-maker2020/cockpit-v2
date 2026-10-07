import { describe, expect, it } from "vitest";
import { lerConfianca, rotuloSugestao, sugestaoLancavel, textoConfianca } from "./sugestao";

describe("sugestão com confiança (regras do histórico real)", () => {
  it("formato do dono: 'Sugestão: 36 — 82% (a Sal fez isso em 41 de 50 casos parecidos)'", () => {
    expect(rotuloSugestao({ codigo: 36, confianca: 0.82, casos: { n: 41, m: 50 } })).toBe(
      "Sugestão: 36 — 82% (a Sal fez isso em 41 de 50 casos parecidos)",
    );
  });
  it("aceita confiança 0–1 ou 0–100, e casos como número + casos_total", () => {
    expect(lerConfianca({ codigo: 1, confianca: 82 }).pct).toBe(82);
    expect(lerConfianca({ codigo: 1, casos: 41, casos_total: 50 })).toEqual({ pct: 82, n: 41, m: 50 });
  });
  it("sem confiança nem casos: só o código (regra pura antiga)", () => {
    expect(textoConfianca({ codigo: 15, regra_id: "r", motivo: "m", lancavel: true })).toBeNull();
    expect(rotuloSugestao({ codigo: 15 })).toBe("Sugestão: 15");
  });
  it("vira botão só com o código liberado; lancavel:false explícito manda", () => {
    const lib = new Set([14, 15]);
    expect(sugestaoLancavel({ codigo: 15 }, lib)).toBe(true);
    expect(sugestaoLancavel({ codigo: 21 }, lib)).toBe(false);
    expect(sugestaoLancavel({ codigo: 15, lancavel: false }, lib)).toBe(false);
    expect(sugestaoLancavel({ codigo: 15 }, null)).toBe(false);
    expect(sugestaoLancavel({ codigo: 15, lancavel: true }, null)).toBe(true);
  });
});
