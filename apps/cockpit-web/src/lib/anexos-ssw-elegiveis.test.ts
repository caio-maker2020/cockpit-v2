// Guard INV-045 — NF 814961 (DUILIO, 23/07): anexo não-suportado FORA da
// seleção. Âncora: 1º anexo é gif de assinatura → pré-seleciona o 2º.
import { describe, expect, it } from "vitest";
import {
  ehAnexoSuportadoSsw,
  primeiroAnexoSuportadoSsw,
} from "./anexos-ssw-elegiveis";

describe("elegibilidade de anexos pro SSW (INV-045)", () => {
  it("suportados: jpeg/jpg/png/pdf; não-suportados: gif, docx, null", () => {
    expect(ehAnexoSuportadoSsw("image/jpeg")).toBe(true);
    expect(ehAnexoSuportadoSsw("image/png")).toBe(true);
    expect(ehAnexoSuportadoSsw("application/pdf")).toBe(true);
    expect(ehAnexoSuportadoSsw("image/gif")).toBe(false);
    expect(ehAnexoSuportadoSsw("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
    expect(ehAnexoSuportadoSsw(null)).toBe(false);
  });

  it("ÂNCORA NF 814961: 1º anexo é gif de assinatura → pré-seleciona o PDF (nunca o gif)", () => {
    const anexos = [
      { id: "a-gif1", mime_type: "image/gif" },
      { id: "a-gif2", mime_type: "image/gif" },
      { id: "a-pdf", mime_type: "application/pdf" },
    ];
    expect(primeiroAnexoSuportadoSsw(anexos)).toBe("a-pdf");
  });

  it("todos não-suportados → null (nada pré-selecionado; operador segue com upload)", () => {
    expect(primeiroAnexoSuportadoSsw([{ id: "x", mime_type: "image/gif" }])).toBe(null);
    expect(primeiroAnexoSuportadoSsw([])).toBe(null);
  });
});
