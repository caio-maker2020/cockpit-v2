// Guard INV-045 — NF 814961 (DUILIO, 23/07): anexo não-suportado FORA da
// seleção. Âncora: 1º anexo é gif de assinatura → pré-seleciona o 2º.
import { describe, expect, it } from "vitest";
import {
  anexosSugeridosDoTodo,
  ehAnexoSuportadoSsw,
  preSelecaoAnexos,
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

describe("pré-seleção com sugestão do agente (onda 2 do veto, 25/08)", () => {
  const anexos = [
    { id: "gif", mime_type: "image/gif" },
    { id: "rom", mime_type: "application/pdf" },
    { id: "foto", mime_type: "image/jpeg" },
  ];

  it("sugestão válida do agente vence a pré-seleção posicional", () => {
    expect(preSelecaoAnexos(anexos, ["rom"])).toEqual(["rom"]);
    expect(preSelecaoAnexos(anexos, ["rom", "foto"])).toEqual(["rom", "foto"]);
  });

  it("sugestão apontando anexo não-suportado ou inexistente é descartada (INV-045)", () => {
    // gif sugerido → filtrado; sobra nada da IA → fallback primeiro suportado
    expect(preSelecaoAnexos(anexos, ["gif"])).toEqual(["rom"]);
    expect(preSelecaoAnexos(anexos, ["nao-existe"])).toEqual(["rom"]);
  });

  it("sem sugestão → comportamento de hoje (primeiro suportado; vazio se nenhum)", () => {
    expect(preSelecaoAnexos(anexos, [])).toEqual(["rom"]);
    expect(preSelecaoAnexos([{ id: "g", mime_type: "image/gif" }], [])).toEqual([]);
  });

  it("anexosSugeridosDoTodo lê meta.anexos_sugeridos com tolerância a lixo", () => {
    expect(
      anexosSugeridosDoTodo({
        meta: { anexos_sugeridos: [{ anexo_id: "a1" }, { anexo_id: 7 }, {}] },
      }),
    ).toEqual(["a1"]);
    expect(anexosSugeridosDoTodo({})).toEqual([]);
    expect(anexosSugeridosDoTodo(null)).toEqual([]);
  });
});
