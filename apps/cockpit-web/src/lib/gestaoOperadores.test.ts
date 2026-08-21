// Guard da Gestão Operadores: horas úteis mandam; média do time é agregada
// (não média de médias); pior cliente primeiro. Máquina de visão 21/08.
import { describe, expect, it } from "vitest";
import {
  filtrarTratativas,
  mediaDoTime,
  resumoPorOperador,
  tempoPorCliente,
  type LinhaFilaAgora,
  type LinhaTratativa,
} from "./gestaoOperadores";

const t = (over: Partial<LinhaTratativa>): LinhaTratativa => ({
  card_id: "c1",
  nf: "1",
  cnpj_pagador: "111",
  empresa_cliente: "ACME",
  operador_id: "op-1",
  dia: "2026-08-20",
  coluna: "aguardando_voce",
  entrada_em: "2026-08-20T11:00:00Z",
  tratado_em: "2026-08-20T12:00:00Z",
  horas_brutas: 1,
  horas_uteis: 1,
  foi_aprovacao: true,
  ...over,
});

describe("resumoPorOperador", () => {
  it("calcula ≤2h úteis, média e paradas por operador", () => {
    const fila: LinhaFilaAgora[] = [
      { card_id: "f1", nf: null, cnpj_pagador: null, empresa_cliente: null, operador_id: "op-1", responsavel_relacionamento: null, coluna: "aguardando_voce", na_fila_desde: "", horas_brutas: 30, horas_uteis: 12, parado_mais_1d_util: true },
      { card_id: "f2", nf: null, cnpj_pagador: null, empresa_cliente: null, operador_id: "op-1", responsavel_relacionamento: null, coluna: "cliente_respondeu", na_fila_desde: "", horas_brutas: 3, horas_uteis: 2, parado_mais_1d_util: false },
    ];
    const r = resumoPorOperador(
      [t({ horas_uteis: 1 }), t({ card_id: "c2", horas_uteis: 5 }), t({ card_id: "c3", operador_id: "op-2", horas_uteis: 0.5 })],
      fila,
    );
    const op1 = r.find((x) => x.operadorId === "op-1")!;
    expect(op1.tratadas).toBe(2);
    expect(op1.ate2hPct).toBe(50);
    expect(op1.horasUteisMedia).toBe(3);
    expect(op1.paradas1d).toBe(1);
    expect(r[0]?.operadorId).toBe("op-1"); // ordena por volume
  });
});

describe("mediaDoTime", () => {
  it("é agregada, não média de médias", () => {
    // op-1: 1 caso ≤2h (100%) · op-2: 3 casos, 0 ≤2h (0%) → time = 1/4 = 25%
    const r = mediaDoTime([
      t({ horas_uteis: 1 }),
      t({ card_id: "a", operador_id: "op-2", horas_uteis: 4 }),
      t({ card_id: "b", operador_id: "op-2", horas_uteis: 4 }),
      t({ card_id: "c", operador_id: "op-2", horas_uteis: 4 }),
    ]);
    expect(r.ate2hPct).toBe(25);
    expect(r.horasUteisMedia).toBe(3.3);
  });
  it("vazio → null (sem dado ≠ 0%)", () => {
    expect(mediaDoTime([]).ate2hPct).toBeNull();
  });
});

describe("tempoPorCliente", () => {
  it("pior cliente primeiro, com mínimo de casos", () => {
    const r = tempoPorCliente(
      [
        t({ cnpj_pagador: "A", empresa_cliente: "Alfa", horas_uteis: 10 }),
        t({ card_id: "2", cnpj_pagador: "A", empresa_cliente: "Alfa", horas_uteis: 8 }),
        t({ card_id: "3", cnpj_pagador: "A", empresa_cliente: "Alfa", horas_uteis: 9 }),
        t({ card_id: "4", cnpj_pagador: "B", empresa_cliente: "Beta", horas_uteis: 1 }),
        t({ card_id: "5", cnpj_pagador: "B", empresa_cliente: "Beta", horas_uteis: 1 }),
        t({ card_id: "6", cnpj_pagador: "B", empresa_cliente: "Beta", horas_uteis: 1 }),
        t({ card_id: "7", cnpj_pagador: "C", horas_uteis: 99 }), // só 1 caso → fora
      ],
      3,
    );
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ cliente: "Alfa", casos: 3, horasUteisMedia: 9 });
  });
});

describe("filtrarTratativas", () => {
  it("filtra por operador, cliente e coluna", () => {
    const base = [
      t({}),
      t({ card_id: "2", operador_id: "op-2", coluna: "cliente_respondeu" }),
    ];
    expect(filtrarTratativas(base, { operadorId: "op-2" })).toHaveLength(1);
    expect(filtrarTratativas(base, { cliente: "ACME" })).toHaveLength(2);
    expect(filtrarTratativas(base, { coluna: "cliente_respondeu" })).toHaveLength(1);
  });
});

// ===== Demanda por ocorrência geradora (Caio 21/08 v2) =====
import { demandaPorOc } from "./gestaoOperadores";

describe("demandaPorOc", () => {
  it("% por oc geradora, maior demanda primeiro; sem oc fica fora", () => {
    const r = demandaPorOc([
      t({ oc_entrada: 10 }), t({ card_id: "2", oc_entrada: 10 }), t({ card_id: "3", oc_entrada: 10 }),
      t({ card_id: "4", oc_entrada: 11 }),
      t({ card_id: "5", oc_entrada: null }),
    ]);
    expect(r[0]).toEqual({ oc: 10, n: 3, pct: 75 });
    expect(r[1]).toEqual({ oc: 11, n: 1, pct: 25 });
  });
});
