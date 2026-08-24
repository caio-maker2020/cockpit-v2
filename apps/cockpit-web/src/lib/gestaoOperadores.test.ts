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

// ===== Drill da demanda por agente (Caio 24/08) =====
import { detalharDemandaPorAgente, emBlocos, type ParFeedbackDemanda } from "./gestaoOperadores";

const par = (over: Partial<ParFeedbackDemanda>): ParFeedbackDemanda => ({
  agent_name: "interpretador-resposta-cliente",
  oc_sugerida: 54,
  oc_executada: 54,
  veredito: "seguida",
  card_id: "c1",
  ...over,
});

describe("detalharDemandaPorAgente", () => {
  it("réplica oc 20 (24/08): seguidas por oc + trocas exatas, maior n primeiro", () => {
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => par({ veredito: "corrigida", oc_sugerida: 54, oc_executada: 55, card_id: `a${i}` })),
      ...Array.from({ length: 7 }, (_, i) => par({ veredito: "corrigida", oc_sugerida: 21, oc_executada: 55, card_id: `b${i}` })),
      ...Array.from({ length: 6 }, (_, i) => par({ veredito: "seguida", oc_sugerida: 54, oc_executada: 54, card_id: `c${i}` })),
      par({ agent_name: "agente-sugere-ocs-padrao", veredito: "seguida", oc_sugerida: 55, oc_executada: 55, card_id: "d1" }),
    ];
    const r = detalharDemandaPorAgente(rows);
    expect(r).toHaveLength(2);
    // maior volume primeiro
    expect(r[0]?.agente).toBe("interpretador-resposta-cliente");
    expect(r[0]).toMatchObject({ pares: 28, seguidas: 6, corrigidas: 22 });
    expect(r[0]?.trocas[0]).toEqual({ sugerida: 54, executada: 55, n: 15 });
    expect(r[0]?.trocas[1]).toEqual({ sugerida: 21, executada: 55, n: 7 });
    expect(r[0]?.seguidasPorOc[0]).toEqual({ oc: 54, n: 6 });
    expect(r[1]).toMatchObject({ agente: "agente-sugere-ocs-padrao", pares: 1, seguidas: 1, pctSeguidas: 100 });
  });

  it("INVARIANTE: seguidas + soma(trocas) === pares em todo agente (números batem)", () => {
    const rows: ParFeedbackDemanda[] = [];
    for (let i = 0; i < 50; i++) {
      rows.push(par({
        agent_name: i % 3 === 0 ? "a" : "b",
        veredito: i % 4 === 0 ? "corrigida" : "seguida",
        oc_sugerida: (i % 5) + 20,
        oc_executada: i % 4 === 0 ? (i % 6) + 30 : (i % 5) + 20,
        card_id: `x${i}`,
      }));
    }
    for (const a of detalharDemandaPorAgente(rows)) {
      expect(a.seguidas + a.trocas.reduce((s, t) => s + t.n, 0)).toBe(a.pares);
      expect(a.seguidas).toBe(a.seguidasPorOc.reduce((s, x) => s + x.n, 0));
      expect(a.corrigidas).toBe(a.pares - a.seguidas);
    }
    // soma dos agentes = total de linhas
    expect(detalharDemandaPorAgente(rows).reduce((s, a) => s + a.pares, 0)).toBe(50);
  });

  it("% de seguidas vem dos contadores (nunca subtração de % arredondado)", () => {
    const rows = [
      ...Array.from({ length: 113 }, (_, i) => par({ card_id: `s${i}` })),
      ...Array.from({ length: 9 }, (_, i) => par({ veredito: "corrigida", oc_executada: 44, card_id: `k${i}` })),
    ];
    expect(detalharDemandaPorAgente(rows)[0]?.pctSeguidas).toBe(92.6);
  });
});

describe("emBlocos", () => {
  it("1.385 ids em blocos de 100 → 14 blocos, nada perdido (oc 20 real)", () => {
    const ids = Array.from({ length: 1385 }, (_, i) => `id${i}`);
    const blocos = emBlocos(ids, 100);
    expect(blocos).toHaveLength(14);
    expect(blocos.flat()).toHaveLength(1385);
    expect(blocos[13]).toHaveLength(85);
  });
});

describe("categoria 'sugeriu manter aguardando' (Caio 24/08, NF 1502332)", () => {
  it("réplica 1502332: sugeriu 54 com card NA 54 → sai das trocas e vira manterAgiu", () => {
    const rows: ParFeedbackDemanda[] = [
      // o par enganoso: interpretador disse "aguarda" (54 em card 54), operador lançou 55
      par({ veredito: "corrigida", oc_sugerida: 54, oc_executada: 55, oc_card: 54, card_id: "m1" }),
      // troca REAL (card estava na 49, sugeriu 54, fez 55) continua nas trocas
      par({ veredito: "corrigida", oc_sugerida: 54, oc_executada: 55, oc_card: 49, card_id: "m2" }),
      // sugeriu aguardar e o operador aguardou (pós-fix do ignorar)
      par({ veredito: "seguida", oc_sugerida: 54, oc_executada: 54, oc_card: 54, card_id: "m3" }),
    ];
    const [a] = detalharDemandaPorAgente(rows);
    expect(a).toMatchObject({ pares: 1, seguidas: 0, corrigidas: 1, manterAguardou: 1 });
    expect(a?.trocas).toEqual([{ sugerida: 54, executada: 55, n: 1 }]);
    expect(a?.manterAgiu).toEqual([{ executada: 55, n: 1 }]);
  });

  it("59 também é manter; sem oc_card não é manter (retrocompatível)", () => {
    const rows: ParFeedbackDemanda[] = [
      par({ veredito: "corrigida", oc_sugerida: 59, oc_executada: 41, oc_card: 59, card_id: "n1" }),
      par({ veredito: "corrigida", oc_sugerida: 54, oc_executada: 55, card_id: "n2" }), // sem oc_card
    ];
    const [a] = detalharDemandaPorAgente(rows);
    expect(a?.manterAgiu).toEqual([{ executada: 41, n: 1 }]);
    expect(a?.trocas).toEqual([{ sugerida: 54, executada: 55, n: 1 }]);
  });
});
