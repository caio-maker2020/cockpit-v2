import { describe, expect, it } from "vitest";
import {
  COLUNAS_COBRANCA,
  comprovantesDaFila,
  csvCobranca,
  excluidoDaLista,
  faixaIdade,
  idadeDias,
  kpis,
  ordenarPorUrgencia,
  porCliente,
  rankingPlacas,
  resumoPorBase,
  situacaoPorBase,
  variacaoBase,
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
    placa: "AAA1B11", data_entrega: diasAtras(2), ultima_oc: 1, descricao_oc: "MERCADORIA ENTREGUE",
    valor_frete: 100, valor_mercadoria: 1000, ...p,
  };
}

describe("idade e faixas", () => {
  it("dias corridos desde a entrega", () => {
    expect(idadeDias(diasAtras(0), AGORA)).toBe(0);
    expect(idadeDias(diasAtras(10), AGORA)).toBe(10);
    expect(idadeDias(null, AGORA)).toBeNull();
  });
  it("Em dia 0–3, Atrasada 4–8, Crítica 9–15, Vencida 16+", () => {
    expect([0, 3, 4, 8, 9, 15, 16, 90].map(faixaIdade)).toEqual(["em_dia", "em_dia", "atrasada", "atrasada", "critica", "critica", "vencida", "vencida"]);
    expect(faixaIdade(null)).toBeNull();
  });
});

describe("agregados", () => {
  const cs = [
    c({ data_entrega: diasAtras(20), placa: "P1" }),
    c({ data_entrega: diasAtras(10), placa: "P1" }),
    c({ data_entrega: diasAtras(1), placa: "P2" }),
    c({ unidade: "BHZ", data_entrega: diasAtras(5), placa: "P3", cliente_pagador: "CLIENTE B" }),
    c({ unidade: null, data_entrega: null, placa: null }),
  ];
  it("KPIs: % sobre (entregues + pendências), valores e faixas", () => {
    const k = kpis(cs, AGORA, 95);
    expect(k.pendencias).toBe(5);
    expect(k.percentual).toBe(5);
    expect(k.frete).toBe(500);
    expect(k.porFaixa).toEqual({ vencida: 1, critica: 1, atrasada: 1, em_dia: 1 });
    expect(kpis(cs, AGORA).percentual).toBeNull();
  });
  it("urgência: vencida primeiro, sem data por último", () => {
    expect(ordenarPorUrgencia(cs, AGORA).map((x) => idadeDias(x.data_entrega, AGORA))).toEqual([20, 10, 5, 1, null]);
  });
  it("resumo por base: pior faixa primeiro, top 3 placas, sem base no fim", () => {
    const r = resumoPorBase(cs, AGORA);
    expect(r.map((b) => b.unidade)).toEqual(["VGA", "BHZ", "Sem base"]);
    expect(r[0]).toMatchObject({ base: "VARGINHA", qtd: 3, pior: "vencida", topPlacas: [{ placa: "P1", qtd: 2 }, { placa: "P2", qtd: 1 }] });
  });
  it("ranking de placas e por cliente", () => {
    expect(rankingPlacas(cs, AGORA)[0]).toMatchObject({ placa: "P1", qtd: 2, vencidas: 1, baseTop: "VGA", outrasBases: 0 });
    expect(rankingPlacas(cs, AGORA).map((p) => p.placa)).not.toContain(null);
    expect(porCliente(cs, AGORA).map((p) => [p.cliente, p.qtd])).toEqual([["CLIENTE A", 4], ["CLIENTE B", 1]]);
  });
});

describe("variação (Melhorando / Piorando / Estável)", () => {
  it("2% de tolerância; anterior zero = novo (piorando)", () => {
    expect(variacaoBase(101, 100).situacao).toBe("estavel");
    expect(variacaoBase(110, 100)).toMatchObject({ situacao: "piorando", rotulo: "+10%" });
    expect(variacaoBase(80, 100)).toMatchObject({ situacao: "melhorando", rotulo: "-20%" });
    expect(variacaoBase(5, 0)).toMatchObject({ situacao: "piorando", rotulo: "novo" });
    expect(variacaoBase(0, 0).situacao).toBe("estavel");
  });
  it("por base: acumulado até o mês anterior × até hoje", () => {
    const s = situacaoPorBase([c({ data_entrega: "2026-09-20" }), c({ data_entrega: "2026-10-02" }), c({ unidade: "BHZ", data_entrega: "2026-09-01" })], AGORA);
    expect(s.find((x) => x.unidade === "VGA")).toMatchObject({ ateMesAnterior: 1000, ateHoje: 2000, situacao: "piorando" });
    expect(s.find((x) => x.unidade === "BHZ")!.situacao).toBe("estavel");
  });
});

describe("fila real, exclusões e CSV", () => {
  it("só a oc 12 da fila vira comprovante, com o item para abrir", () => {
    const l = { op_item_id: "x1", ctrc: "VGA1", nf: "9", unidade: "VGA", cod_ultima_ocorrencia: 12, descricao_oc: "COMPROVANTE RETIDO PARA CONFERENCIA", data_ultima_ocorrencia: "2026-10-01", pagador: "P" } as OpFilaLinha;
    const r = comprovantesDaFila([l, { ...l, op_item_id: "x2", cod_ultima_ocorrencia: 41 }]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ origem: "fila", op_item_id: "x1", base_tipo: "filial", placa: null });
  });
  it("ressarcimento sai da lista", () => {
    expect(excluidoDaLista({ descricao_oc: "EM ANALISE DE RESSARCIMENTO" })).toBe(true);
    expect(excluidoDaLista({ descricao_oc: "MERCADORIA ENTREGUE" })).toBe(false);
  });
  it("CSV de uma base, mais urgente primeiro", () => {
    const csv = csvCobranca([c({ data_entrega: diasAtras(1) }), c({ data_entrega: diasAtras(30), valor_frete: 12.5 }), c({ unidade: "BHZ" })], AGORA, "VGA");
    const [cab, ...ls] = csv.split("\r\n");
    expect(cab).toBe(COLUNAS_COBRANCA.join(";"));
    expect(ls).toHaveLength(2);
    expect(ls[0]).toContain(";30;Vencida;1 - MERCADORIA ENTREGUE;12,50;1000,00");
  });
});

describe("demonstração determinística", () => {
  it("mesma lista sempre, ~60 itens fictícios", () => {
    const a = gerarComprovantesDemo(AGORA);
    expect(a).toHaveLength(60);
    expect(gerarComprovantesDemo(AGORA)).toEqual(a);
    expect(a.every((x) => x.origem === "demo" && /^[A-Z]{3}\d[A-Z]\d{2}$|^$/.test(x.placa ?? ""))).toBe(true);
    const k = kpis(a, AGORA);
    expect(k.porFaixa.vencida).toBeGreaterThan(0);
    expect(k.porFaixa.em_dia).toBeGreaterThan(0);
  });
});
