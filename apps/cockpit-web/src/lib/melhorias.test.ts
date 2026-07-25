// INV-051 — guard anti-regressão do fix da fila de melhorias F6
// (rejeição acidental de 24/07: sem confirm, sem undo, rótulo enganoso).
import { describe, expect, it } from "vitest";
import { nasceuDaMinhaResposta, podeReabrir, rotuloRevisao } from "./melhorias";

describe("podeReabrir (INV-051)", () => {
  it("aprovado e rejeitado reabrem (undo humano)", () => {
    expect(podeReabrir("aprovado")).toBe(true);
    expect(podeReabrir("rejeitado")).toBe(true);
  });

  it("terminais dos agentes e demais status NUNCA reabrem", () => {
    for (const s of ["aplicado", "revertido", "aberto", "observacao", "respondido", ""]) {
      expect(podeReabrir(s)).toBe(false);
    }
  });
});

describe("nasceuDaMinhaResposta (aviso anti-eco pro autor)", () => {
  it("true só quando autor da resposta === gestor logado", () => {
    expect(nasceuDaMinhaResposta("op-isadora", "op-isadora")).toBe(true);
    expect(nasceuDaMinhaResposta("op-isadora", "op-caio")).toBe(false);
  });

  it("sem autor ou sem operador logado, nunca acusa", () => {
    expect(nasceuDaMinhaResposta(null, "op-caio")).toBe(false);
    expect(nasceuDaMinhaResposta("op-isadora", null)).toBe(false);
    expect(nasceuDaMinhaResposta(undefined, undefined)).toBe(false);
  });
});

describe("rotuloRevisao (trilha do que já foi revisado)", () => {
  it("nomeia quem decidiu — o gap que escondeu as revisões da Isadora", () => {
    expect(rotuloRevisao("rejeitado", "Isadora Baldoni", false)).toBe(
      "rejeitada por Isadora Baldoni",
    );
    expect(rotuloRevisao("aprovado", "Caio Vasconcelos", true)).toBe(
      "aprovada por você",
    );
    expect(rotuloRevisao("rejeitado", null, false)).toBe("rejeitada por outro gestor");
  });
});
