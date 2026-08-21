// Guard da Gestão Agentes: % nunca é média de médias; matriz ordena pelo pior;
// sem pares = null (não 0%). Plano máquina-de-visão 21/08.
import { describe, expect, it } from "vitest";
import {
  diaBrtAtras,
  filtrarPlacar,
  matrizDivergencia,
  porAgente,
  porFatia,
  seriePorDia,
  somarPlacar,
  type LinhaDivergencia,
  type LinhaPlacarGestao,
} from "./gestaoAgentes";
import { AGENTES_CATALOGO, agenteAmigavel } from "./agentesCatalogo";

const linha = (over: Partial<LinhaPlacarGestao>): LinhaPlacarGestao => ({
  dia: "2026-08-20",
  agent_name: "agente-sugere-ocs-padrao",
  oc_sugerida: 21,
  modo: "sugestao",
  operador_id: "op-1",
  operador_nome: "DUILIO",
  seguidas: 0,
  corrigidas: 0,
  abstencoes: 0,
  pares: 0,
  ...over,
});

describe("somarPlacar", () => {
  it("soma pares e calcula % agregada (não média de médias)", () => {
    // dia 1: 1/10 (10%) · dia 2: 90/90 (100%) → agregado = 91/100 = 91%, não 55%
    const t = somarPlacar([
      linha({ dia: "d1", seguidas: 1, corrigidas: 9, pares: 10 }),
      linha({ dia: "d2", seguidas: 90, corrigidas: 0, pares: 90 }),
    ]);
    expect(t.pctAcerto).toBe(91);
    expect(t.pares).toBe(100);
  });

  it("sem pares → pctAcerto null (sem dado ≠ 0%)", () => {
    expect(somarPlacar([linha({ abstencoes: 5 })]).pctAcerto).toBeNull();
  });
});

describe("filtros e agrupamentos", () => {
  const base = [
    linha({ agent_name: "a", operador_id: "op-1", seguidas: 8, corrigidas: 2, pares: 10 }),
    linha({ agent_name: "a", operador_id: "op-2", seguidas: 1, corrigidas: 1, pares: 2 }),
    linha({ agent_name: "b", operador_id: "op-1", oc_sugerida: 44, seguidas: 5, pares: 5 }),
  ];

  it("filtrarPlacar por agente e operador", () => {
    expect(filtrarPlacar(base, { agente: "a" })).toHaveLength(2);
    expect(filtrarPlacar(base, { operadorId: "op-1" })).toHaveLength(2);
    expect(filtrarPlacar(base, { agente: "a", operadorId: "op-2" })).toHaveLength(1);
  });

  it("porAgente ordena por volume", () => {
    const r = porAgente(base);
    expect(r[0]?.agent_name).toBe("a");
    expect(r[0]?.pares).toBe(12);
  });

  it("porFatia separa por oc sugerida", () => {
    const r = porFatia(base);
    expect(r.find((f) => f.agent_name === "b" && f.oc_sugerida === 44)?.pctAcerto).toBe(100);
  });

  it("seriePorDia soma o dia inteiro", () => {
    const r = seriePorDia([
      linha({ dia: "2026-08-19", seguidas: 1, pares: 2 }),
      linha({ dia: "2026-08-19", seguidas: 1, pares: 2, operador_id: "op-2" }),
    ]);
    expect(r).toEqual([{ dia: "2026-08-19", pct: 50, pares: 4 }]);
  });
});

describe("matrizDivergencia", () => {
  it("agrega o mesmo par sugerida→executada e ordena pelo pior", () => {
    const l = (over: Partial<LinhaDivergencia>): LinhaDivergencia => ({
      dia: "2026-08-20",
      agent_name: "a",
      oc_sugerida: 33,
      oc_executada: 44,
      operador_id: null,
      operador_nome: null,
      n: 1,
      ultimo_em: "2026-08-20T10:00:00Z",
      cards_exemplo: ["c1"],
      ...over,
    });
    const r = matrizDivergencia([
      l({ n: 2 }),
      l({ n: 5, dia: "2026-08-19", ultimo_em: "2026-08-19T10:00:00Z" }),
      l({ oc_executada: 21, n: 3 }),
    ]);
    expect(r[0]).toMatchObject({ oc_sugerida: 33, oc_executada: 44, n: 7, ultimo_em: "2026-08-20T10:00:00Z" });
    expect(r[1]?.n).toBe(3);
  });
});

describe("catálogo", () => {
  it("os 5 agentes medidos têm descrição pro tooltip '?'", () => {
    for (const nome of [
      "agente-sugere-ocs-padrao",
      "interpretador-resposta-cliente",
      "agente-oc13-autonomo",
      "scan-email-pre-card",
      "robo-intranet-wurth",
    ]) {
      expect(AGENTES_CATALOGO[nome]?.oQueFaz).toBeTruthy();
      expect(AGENTES_CATALOGO[nome]?.oQueSugere).toBeTruthy();
    }
    expect(agenteAmigavel("desconhecido-x")).toBe("desconhecido-x");
  });
});

describe("diaBrtAtras", () => {
  it("converte pro dia BRT correto", () => {
    // 2026-08-21 01:00 UTC = 2026-08-20 22:00 BRT → 7 dias atrás = 2026-08-13
    expect(diaBrtAtras(7, new Date("2026-08-21T01:00:00Z"))).toBe("2026-08-13");
  });
});
