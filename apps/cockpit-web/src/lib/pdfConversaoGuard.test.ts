// Guard anti-regressão do caso âncora NF 135724 (2026-07-17): pdf.js "converte
// com sucesso" um scan JBIG2 e entrega página quase em branco. O guard tem que
// pegar (a) o warning do pdf.js e (b) a página quase branca SEM warning — os
// dois modos reais medidos (4/5 PDFs JBIG2 quebraram; 1 deles calado).
import { describe, expect, it } from "vitest";
import {
  avaliarPaginaConvertida,
  mensagemConversaoQuebrada,
  PISO_PIXELS_NAO_BRANCOS,
  RE_WARNING_PDFJS_IMG,
} from "./pdfConversaoGuard";

/** Monta um ImageData.data RGBA com `fracaoEscura` dos pixels pretos. */
function rgba(totalPx: number, fracaoEscura: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(totalPx * 4).fill(255);
  const escuros = Math.floor(totalPx * fracaoEscura);
  for (let p = 0; p < escuros; p++) {
    data[p * 4] = 0;
    data[p * 4 + 1] = 0;
    data[p * 4 + 2] = 0;
  }
  return data;
}

describe("avaliarPaginaConvertida", () => {
  it("página quase branca SEM warning ⇒ quebrada (caso 'minuta assinada.pdf': 0,38%, calado)", () => {
    const v = avaliarPaginaConvertida(rgba(10_000, 0.004), false);
    expect(v.quebrada).toBe(true);
    expect(v.motivo).toBe("pagina_quase_branca");
  });

  it("warning do pdf.js ⇒ quebrada MESMO com muito conteúdo (caso doc assinado: 51,7% e fragmentado)", () => {
    const v = avaliarPaginaConvertida(rgba(10_000, 0.5), true);
    expect(v.quebrada).toBe(true);
    expect(v.motivo).toBe("warning_pdfjs");
  });

  it("página normal sem warning ⇒ passa (DANFE convertido da NF 135724 era ok)", () => {
    const v = avaliarPaginaConvertida(rgba(10_000, 0.08), false);
    expect(v.quebrada).toBe(false);
    expect(v.motivo).toBeNull();
  });

  it("limiar: exatamente no piso passa; abaixo do piso quebra", () => {
    expect(avaliarPaginaConvertida(rgba(10_000, PISO_PIXELS_NAO_BRANCOS), false).quebrada).toBe(false);
    expect(avaliarPaginaConvertida(rgba(10_000, PISO_PIXELS_NAO_BRANCOS / 2), false).quebrada).toBe(true);
  });
});

describe("RE_WARNING_PDFJS_IMG", () => {
  it("casa o warning real do pdf.js (com e sem apóstrofo)", () => {
    expect(RE_WARNING_PDFJS_IMG.test("Warning: Dependent image isn't ready yet")).toBe(true);
    expect(RE_WARNING_PDFJS_IMG.test("Dependent image isnt ready yet")).toBe(true);
    expect(RE_WARNING_PDFJS_IMG.test("TextLayer task cancelled")).toBe(false);
  });
});

describe("mensagemConversaoQuebrada", () => {
  it("menciona arquivo, página e o contorno (print/foto)", () => {
    const msg = mensagemConversaoQuebrada("NF 135724.pdf", 1, "warning_pdfjs");
    expect(msg).toContain("NF 135724.pdf");
    expect(msg).toContain("Página 1");
    expect(msg).toContain("print/foto");
  });
});
