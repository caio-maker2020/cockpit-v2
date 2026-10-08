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

// ===== Drill por oc geradora + régua de autonomia (Caio 21/08 v2) =====
import { drillCorrigidas, drillSeguidas, fatiaProntaPraAutonomia, type LinhaDivergencia as LD } from "./gestaoAgentes";

describe("drill por fatia (oc geradora → sugestão → execução)", () => {
  const placar = [
    linha({ agent_name: "a", oc_card: 10, oc_sugerida: 44, seguidas: 48, corrigidas: 2, pares: 50 }),
    linha({ agent_name: "a", oc_card: 11, oc_sugerida: 44, seguidas: 5, corrigidas: 15, pares: 20 }),
  ] as Parameters<typeof drillSeguidas>[0];
  const diverg: LD[] = [
    { dia: "d", agent_name: "a", oc_card: 11, oc_sugerida: 44, oc_executada: 21, operador_id: null, operador_nome: null, n: 12, ultimo_em: "t", cards_exemplo: ["c1"] },
    { dia: "d", agent_name: "a", oc_card: 11, oc_sugerida: 44, oc_executada: 56, operador_id: null, operador_nome: null, n: 3, ultimo_em: "t", cards_exemplo: [] },
    { dia: "d", agent_name: "a", oc_card: 10, oc_sugerida: 44, oc_executada: 21, operador_id: null, operador_nome: null, n: 2, ultimo_em: "t", cards_exemplo: [] },
  ];

  it("corrigidas: UMA linha por troca exata, pior primeiro; n bate 1:1 com o 'ver casos' (Caio 24/08)", () => {
    const r = drillCorrigidas(placar, diverg);
    // fatia 11→44 tem DUAS trocas (fez 21 e fez 56) → duas linhas, não uma "dominante"
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ oc_card: 11, oc_sugerida: 44, oc_executada: 21, n: 12, pares: 20, pctSeguidas: 25, pctCorrigidas: 60 });
    expect(r[1]).toMatchObject({ oc_card: 11, oc_sugerida: 44, oc_executada: 56, n: 3, pares: 20, pctCorrigidas: 15 });
    expect(r[2]).toMatchObject({ oc_card: 10, oc_executada: 21, n: 2, pctSeguidas: 96, pctCorrigidas: 4 });
    // soma das linhas da fatia 11→44 = total de corrigidas dela (15)
    expect(r.filter((x) => x.oc_card === 11).reduce((s, x) => s + x.n, 0)).toBe(15);
  });

  it("fix 21/08: pctSeguidas + pctCorrigidas fecham 100 (fatia 35→54 do Caio: 92,6% × 7,4%)", () => {
    // réplica do caso real: 122 pares · 113 seguidas · 9 corrigidas
    const placarReal = [linha({ agent_name: "sug", oc_card: 35, oc_sugerida: 54, seguidas: 113, corrigidas: 9, pares: 122 })];
    const divergReal: LD[] = [{ dia: "d", agent_name: "sug", oc_card: 35, oc_sugerida: 54, oc_executada: 44, operador_id: null, operador_nome: null, n: 9, ultimo_em: "t", cards_exemplo: [] }];
    const [c] = drillCorrigidas(placarReal, divergReal);
    const [sg] = drillSeguidas(placarReal);
    expect(c).toMatchObject({ pctCorrigidas: 7.4, pctSeguidas: 92.6, pares: 122, n: 9, oc_executada: 44 });
    expect(sg).toMatchObject({ pctSeguidas: 92.6, pctCorrigidas: 7.4, pares: 122, n: 113 });
    expect((c!.pctSeguidas ?? 0) + (c!.pctCorrigidas ?? 0)).toBe(100);
  });

  it("seguidas: melhor fatia primeiro; ≥95% e ≥50 pares = pronta pra autônomo", () => {
    const r = drillSeguidas(placar);
    expect(r[0]).toMatchObject({ oc_card: 10, pctSeguidas: 96, pares: 50 });
    expect(fatiaProntaPraAutonomia(r[0]!)).toBe(true);
    expect(fatiaProntaPraAutonomia(r[1]!)).toBe(false); // 25% / 20 pares
  });
});

import { faixaConfianca, rankingAgentes } from "./gestaoAgentes";

describe("torre — ranking de agentes", () => {
  const l = (agent_name: string, dia: string, seguidas: number, pares: number): LinhaPlacarGestao => ({
    dia, agent_name, oc_sugerida: 21, modo: null, operador_id: null, operador_nome: null,
    seguidas, corrigidas: pares - seguidas, abstencoes: 0, pares,
  });

  it("ordena do que mais acerta pro que menos; amostra fraca vai pro fim", () => {
    const r = rankingAgentes([
      l("a", "2026-10-01", 50, 100),
      l("b", "2026-10-01", 90, 100),
      l("c", "2026-10-01", 3, 3), // 100% mas só 3 pares
    ]);
    expect(r.map((x) => x.agent_name)).toEqual(["b", "a", "c"]);
    expect(r[0]!.posicao).toBe(1);
  });

  it("delta = 2ª metade − 1ª metade, somando contadores (não média de %)", () => {
    const r = rankingAgentes([
      l("a", "2026-10-01", 5, 10),
      l("a", "2026-10-02", 45, 50),
      l("a", "2026-10-03", 18, 20),
    ]);
    // corte = 10-02 → antes 5/10=50%, depois 63/70=90%
    expect(r[0]!.pctAntes).toBe(50);
    expect(r[0]!.pctDepois).toBe(90);
    expect(r[0]!.delta).toBe(40);
  });

  it("faixa de confiança", () => {
    expect(faixaConfianca(null)).toBe("sem_dado");
    expect(faixaConfianca(95)).toBe("firme");
    expect(faixaConfianca(80)).toBe("atencao");
    expect(faixaConfianca(79.9)).toBe("fraco");
  });
});

import { inicioSemana, seriePorSemana } from "./gestaoAgentes";

describe("torre — evolução semanal", () => {
  const l = (agent_name: string, dia: string, seguidas: number, pares: number): LinhaPlacarGestao => ({
    dia, agent_name, oc_sugerida: 21, modo: null, operador_id: null, operador_nome: null,
    seguidas, corrigidas: pares - seguidas, abstencoes: 0, pares,
  });
  it("semana começa na segunda", () => {
    expect(inicioSemana("2026-10-08")).toBe("2026-10-05"); // qui → seg
    expect(inicioSemana("2026-10-05")).toBe("2026-10-05");
    expect(inicioSemana("2026-10-11")).toBe("2026-10-05"); // dom
  });
  it("soma contadores por semana e expõe a janela do delta", () => {
    const linhas = [l("a", "2026-10-05", 1, 2), l("a", "2026-10-06", 3, 8), l("a", "2026-10-12", 9, 10)];
    const s = seriePorSemana(linhas).get("a")!;
    expect(s).toEqual([
      { semana: "2026-10-05", pares: 10, seguidas: 4, pct: 40 },
      { semana: "2026-10-12", pares: 10, seguidas: 9, pct: 90 },
    ]);
    const r = rankingAgentes(linhas)[0]!;
    expect(r.janelaAntes).toEqual({ de: "2026-10-05", ate: "2026-10-05" });
    expect(r.janelaDepois).toEqual({ de: "2026-10-06", ate: "2026-10-12" });
  });
});

import { contarCiclo, etapaDoItem, pontosPorTroca, trocasAteAMeta } from "./gestaoAgentes";

describe("torre — pontos por troca", () => {
  const pl = (agent_name: string, seguidas: number, pares: number): LinhaPlacarGestao => ({
    dia: "2026-10-01", agent_name, oc_sugerida: 21, oc_card: 11, modo: null, operador_id: null,
    operador_nome: null, seguidas, corrigidas: pares - seguidas, abstencoes: 0, pares,
  });
  const dv = (agent_name: string, oc_executada: number, n: number): LinhaDivergencia => ({
    dia: "2026-10-01", agent_name, oc_sugerida: 21, oc_card: 11, oc_executada, operador_id: null,
    operador_nome: null, n, ultimo_em: "2026-10-01", cards_exemplo: null,
  });
  it("pts do agente e do global, maior ganho primeiro", () => {
    const t = pontosPorTroca([pl("a", 60, 100), pl("b", 90, 100)], [dv("a", 54, 30), dv("b", 44, 10)]);
    expect(t[0]).toMatchObject({ agent_name: "a", oc_executada: 54, ptsAgente: 30, ptsGlobal: 15, pctAgenteSeResolver: 90 });
    expect(t[1]).toMatchObject({ agent_name: "b", ptsAgente: 10, ptsGlobal: 5 });
  });
  it("quantas trocas até a meta", () => {
    const t = pontosPorTroca([pl("a", 60, 100), pl("b", 90, 100)], [dv("a", 54, 30), dv("b", 44, 10)]);
    expect(trocasAteAMeta(t, 75)).toBe(2); // 75+15+5 = 95
    expect(trocasAteAMeta(t, 96)).toBe(0);
    expect(trocasAteAMeta(t, 50)).toBeNull();
  });
});

describe("torre — ciclo de aprendizado", () => {
  const it0 = { id: "1", agente_alvo: null, titulo: null, resumo: null, created_at: "", detalhes: null };
  it("classifica a etapa; merge vence status", () => {
    expect(etapaDoItem({ ...it0, tipo: "ajuste_sugerido", status: "aberto" })).toBe("sugerida");
    expect(etapaDoItem({ ...it0, tipo: "ajuste_sugerido", status: "aprovado" })).toBe("aprovada");
    expect(etapaDoItem({ ...it0, tipo: "ajuste_sugerido", status: "aprovado", detalhes: { mergeado_em: "x" } })).toBe("no_ar");
    expect(etapaDoItem({ ...it0, tipo: "ajuste_sugerido", status: "rejeitado" })).toBe("recusada");
    expect(etapaDoItem({ ...it0, tipo: "metrica_snapshot", status: "observacao" })).toBeNull();
    expect(contarCiclo([{ ...it0, tipo: "pergunta", status: "aberto" }]).pergunta).toBe(1);
  });
});
