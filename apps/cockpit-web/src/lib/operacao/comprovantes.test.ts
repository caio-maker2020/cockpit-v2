import { describe, expect, it } from "vitest";
import {
  COLUNAS_COBRANCA,
  FAIXAS_IDADE,
  LIMITE_ITENS_TEXTO,
  comprovantesDaFila,
  csvCobranca,
  dataBr,
  excluidoDaLista,
  faixaIdade,
  idadeDe,
  idadeDias,
  kpis,
  ligarComFila,
  mediana,
  ordenarPorIdade,
  respostaDaApi,
  resumoPorBase,
  textoCobranca,
  type ComprovantePendente,
} from "./comprovantes";
import { gerarComprovantesDemo } from "./demo/comprovantesDemo";
import type { OpFilaLinha } from "./tipos";

const AGORA = Date.parse("2026-10-08T15:00:00Z");
const diasAtras = (d: number) => new Date(Date.UTC(2026, 9, 8 - d)).toISOString().slice(0, 10);

let seq = 0;
function c(p: Partial<ComprovantePendente> = {}): ComprovantePendente {
  seq++;
  return {
    ctrc: `CT${String(seq).padStart(3, "0")}`, nf: `${seq}`, unidade: "VGA", base_tipo: "filial", cliente_pagador: "CLIENTE A",
    placa: "AAA1B11", data_entrega: diasAtras(2), descricao_oc: "MERCADORIA ENTREGUE",
    valor_frete: 100, valor_mercadoria: 1000, origem: "fonte", ...p,
  };
}

describe("idade e faixas", () => {
  it("dias corridos desde a entrega; a idade da fonte manda", () => {
    expect(idadeDias(diasAtras(0), AGORA)).toBe(0);
    expect(idadeDias(diasAtras(10), AGORA)).toBe(10);
    expect(idadeDias(null, AGORA)).toBeNull();
    expect(idadeDe({ idade_dias: 40, data_entrega: diasAtras(2) }, AGORA)).toBe(40);
    expect(idadeDe({ idade_dias: null, data_entrega: diasAtras(2) }, AGORA)).toBe(2);
  });
  it("as faixas executadas: 0-5, 6-10, 11-30, 31-60, 61-90, 91-150, 151+", () => {
    expect(FAIXAS_IDADE.map((f) => f.id)).toEqual(["0-5", "6-10", "11-30", "31-60", "61-90", "91-150", "151+"]);
    expect([0, 5, 6, 10, 11, 30, 31, 60, 61, 90, 91, 150, 151, 900].map(faixaIdade)).toEqual([
      "0-5", "0-5", "6-10", "6-10", "11-30", "11-30", "31-60", "31-60", "61-90", "61-90", "91-150", "91-150", "151+", "151+",
    ]);
    expect(faixaIdade(null)).toBeNull();
  });
  it("mediana", () => {
    expect(mediana([])).toBeNull();
    expect(mediana([5, 1, 3])).toBe(3);
    expect(mediana([1, 2, 3, 10])).toBe(2.5);
  });
});

describe("agregados", () => {
  const cs = [
    c({ data_entrega: diasAtras(200), placa: "P1" }),
    c({ data_entrega: diasAtras(10), placa: "P1" }),
    c({ data_entrega: diasAtras(1), placa: "P2" }),
    c({ unidade: "BHZ", data_entrega: diasAtras(40), placa: "P3", cliente_pagador: "CLIENTE B" }),
    c({ unidade: "POA", data_entrega: diasAtras(40), placa: null }),
    c({ unidade: "POA", data_entrega: diasAtras(35), placa: null }),
    c({ unidade: null, data_entrega: null, placa: null }),
  ];
  it("KPIs: % = pendentes ÷ (pendentes + entregues), valores, mediana e faixas", () => {
    const k = kpis(cs, AGORA, 93);
    expect(k.pendentes).toBe(7);
    expect(k.percentual).toBe(7);
    expect(k.frete).toBe(700);
    expect(k.mercadoria).toBe(7000);
    expect(k.medianaIdade).toBe(37.5);
    expect(k.porFaixa).toEqual({ "0-5": 1, "6-10": 1, "11-30": 0, "31-60": 3, "61-90": 0, "91-150": 0, "151+": 1 });
    expect(kpis(cs, AGORA).percentual).toBeNull();
  });
  it("mais velho primeiro, sem data por último", () => {
    expect(ordenarPorIdade(cs, AGORA).map((x) => idadeDe(x, AGORA))).toEqual([200, 40, 40, 35, 10, 1, null]);
  });
  it("bases da pior para a melhor; dentro, base → placa (sem placa por último)", () => {
    const r = resumoPorBase(cs, AGORA);
    expect(r.map((b) => b.unidade)).toEqual(["VGA", "POA", "BHZ", "Sem base"]);
    expect(r[0]).toMatchObject({ base: "VARGINHA", qtd: 3, pior: "151+", maisVelho: 200 });
    expect(r[0]!.placas.map((p) => [p.placa, p.qtd])).toEqual([["P1", 2], ["P2", 1]]);
    expect(r[1]!.placas.map((p) => p.placa)).toEqual(["Sem placa"]);
  });
});

describe("resposta da edge", () => {
  it("mapeia as linhas e os totais; tipos errados viram null", () => {
    const r = respostaDaApi({
      ok: true,
      linhas: [{ ctrc: "VGA1-1", nf: "9", unidade: "vga", base_nome: "VARGINHA", base_tipo: "FILIAL", data_entrega: "2026-10-01", idade_dias: 7, valor_frete: "x" }, { ctrc: "" }],
      entregues: 500,
      ultimaAtualizacao: "2026-10-08",
      escopo: { todas: false, unidades: ["VGA"] },
      excluidas: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0]).toMatchObject({ ctrc: "VGA1-1", unidade: "VGA", base_tipo: "filial", idade_dias: 7, valor_frete: null, origem: "fonte" });
    expect(r).toMatchObject({ entregues: 500, ultimaAtualizacao: "2026-10-08", escopo: { todas: false, unidades: ["VGA"] }, excluidas: 2 });
  });
  it("erro da edge vira {ok:false} com o código (sem fallback)", () => {
    expect(respostaDaApi({ ok: false, erro: "comprovantes_sem_credencial" })).toEqual({ ok: false, erro: "comprovantes_sem_credencial", motivo: undefined });
    expect(respostaDaApi(null)).toMatchObject({ ok: false, erro: "falha_de_comunicacao" });
  });
});

describe("fila, exclusões, texto e CSV", () => {
  const l = { op_item_id: "x1", ctrc: "VGA1-1", nf: "9", unidade: "VGA", cod_ultima_ocorrencia: 12, descricao_oc: "COMPROVANTE RETIDO PARA CONFERENCIA", data_ultima_ocorrencia: "2026-10-01T10:00:00Z", pagador: "P" } as OpFilaLinha;
  it("só a oc 12 da fila vira comprovante (demo)", () => {
    const r = comprovantesDaFila([l, { ...l, op_item_id: "x2", cod_ultima_ocorrencia: 41 }]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ origem: "fila", op_item_id: "x1", base_tipo: "filial", placa: null, data_entrega: "2026-10-01" });
  });
  it("liga o comprovante à nota da fila com oc 12 pelo CTRC", () => {
    const r = ligarComFila([c({ ctrc: "vga1-1" }), c({ ctrc: "OUTRO" })], [l, { ...l, op_item_id: "x9", ctrc: "OUTRO", cod_ultima_ocorrencia: 41 }]);
    expect(r.map((x) => x.op_item_id)).toEqual(["x1", undefined]);
  });
  it("ressarcimento e o CTRC em duplicidade saem", () => {
    expect(excluidoDaLista({ descricao_oc: "EM ANALISE DE RESSARCIMENTO" })).toBe(true);
    expect(excluidoDaLista({ ctrc: "ovd352980-1", descricao_oc: null })).toBe(true);
    expect(excluidoDaLista({ ctrc: "X", descricao_oc: "MERCADORIA ENTREGUE" })).toBe(false);
  });
  it("data sem deslocamento de fuso", () => {
    expect(dataBr("2026-10-01")).toBe("01/10/2026");
    expect(dataBr(null)).toBe("");
  });
  it("texto de cobrança: base, quantidade, top placas e a lista CTRC/NF/cliente/idade", () => {
    const b = resumoPorBase([c({ ctrc: "A-1", nf: "11", placa: "P1", data_entrega: diasAtras(30) }), c({ ctrc: "B-1", nf: null, placa: "P1" }), c({ ctrc: "C-1", placa: "P2" })], AGORA)[0]!;
    const t = textoCobranca(b, AGORA);
    expect(t).toContain("base VGA (VARGINHA)");
    expect(t).toContain("3 entregas sem comprovante escaneado; a mais antiga tem 30 dias.");
    expect(t).toContain("Placas com mais pendências: P1 (2), P2 (1).");
    expect(t).toContain("A-1 | 11 | CLIENTE A | 30 dias");
    expect(t).toContain("B-1 | - | CLIENTE A | 2 dias");
  });
  it("texto de cobrança corta a lista longa e manda para o CSV", () => {
    const b = resumoPorBase(Array.from({ length: LIMITE_ITENS_TEXTO + 5 }, () => c()), AGORA)[0]!;
    expect(textoCobranca(b, AGORA)).toContain("… e mais 5. A lista completa está no CSV.");
  });
  it("CSV de uma base, mais velho primeiro, com faixa e data DD/MM/AAAA", () => {
    const csv = csvCobranca([c({ data_entrega: diasAtras(1) }), c({ data_entrega: "2026-09-08", valor_frete: 12.5 }), c({ unidade: "BHZ" })], AGORA, "VGA");
    const [cab, ...ls] = csv.split("\r\n");
    expect(cab).toBe(COLUNAS_COBRANCA.join(";"));
    expect(ls).toHaveLength(2);
    expect(ls[0]).toContain(";08/09/2026;30;11 a 30 dias;MERCADORIA ENTREGUE;12,50;1000,00");
    expect(csvCobranca([c(), c({ unidade: "BHZ" })], AGORA).split("\r\n")).toHaveLength(3);
  });
});

describe("demonstração determinística", () => {
  it("mesma lista sempre, ~60 itens fictícios", () => {
    const a = gerarComprovantesDemo(AGORA);
    expect(a).toHaveLength(60);
    expect(gerarComprovantesDemo(AGORA)).toEqual(a);
    expect(a.every((x) => x.origem === "demo" && /^[A-Z]{3}\d[A-Z]\d{2}$|^$/.test(x.placa ?? ""))).toBe(true);
    const k = kpis(a, AGORA);
    expect(k.porFaixa["0-5"]).toBeGreaterThan(0);
    expect(k.porFaixa["31-60"]).toBeGreaterThan(0);
  });
});
