import { describe, expect, it } from "vitest";
import {
  agregarPlacar,
  META_ACERTO_PCT,
  montarPerguntaDaOc,
  vereditoDoAgente,
  VOLUME_CONFIAVEL,
  VOLUME_MINIMO_FATIA,
  type LinhaErro,
  type LinhaPlacar,
} from "./placarAgentes";

// Quinta 2026-08-13. Janela recente = 12/08 → 04/08; anterior = 03/08 → 28/07.
const AGORA = new Date("2026-08-13T15:00:00Z");

const l = (
  dia: string,
  agent_name: string,
  seguidas: number,
  corrigidas: number,
  fatia_oc_sugerida: number | null = null,
): LinhaPlacar => ({ dia, agent_name, fatia_oc_sugerida, seguidas, corrigidas, pares: seguidas + corrigidas });

describe("agregarPlacar", () => {
  it("acerto = seguidas/(seguidas+corrigidas), por agente e global", () => {
    const r = agregarPlacar(
      [l("2026-08-12", "a", 8, 2), l("2026-08-11", "b", 1, 9)],
      [],
      AGORA,
    );
    expect(r.global.pct).toBe(45); // 9 seguidas de 20 pares
    expect(r.agentes.find((x) => x.agente === "a")?.pct).toBe(80);
    expect(r.agentes.find((x) => x.agente === "b")?.pct).toBe(10);
  });

  it("delta compara com o período anterior de mesmo tamanho", () => {
    const r = agregarPlacar(
      [l("2026-08-12", "a", 9, 1), l("2026-07-31", "a", 5, 5)],
      [],
      AGORA,
    );
    expect(r.agentes[0].pct).toBe(90);
    expect(r.agentes[0].delta).toBe(40); // 90 − 50
  });

  it("ignora dias fora das duas janelas", () => {
    const r = agregarPlacar([l("2026-08-12", "a", 1, 0), l("2026-01-05", "a", 0, 99)], [], AGORA);
    expect(r.agentes[0].corrigidas).toBe(0);
  });

  it("ordena agentes por VOLUME (o que mais impacta aparece primeiro)", () => {
    const r = agregarPlacar(
      [l("2026-08-12", "pequeno", 1, 1), l("2026-08-12", "grande", 50, 50)],
      [],
      AGORA,
    );
    expect(r.agentes[0].agente).toBe("grande");
  });

  // A regra que destrava a autonomia: promove-se por FATIA, não pelo global.
  it("fatia acima da meta com volume vira candidata; global fraco não impede", () => {
    const linhas = [
      l("2026-08-12", "a", 96, 4, 44), // fatia oc44: 96%
      l("2026-08-12", "a", 10, 90, 56), // fatia oc56: 10% (puxa o global pra baixo)
    ];
    const r = agregarPlacar(linhas, [], AGORA);
    expect(r.global.pct).toBeLessThan(META_ACERTO_PCT);
    expect(r.fatiasProntas).toHaveLength(1);
    expect(r.fatiasProntas[0].oc).toBe(44);
    expect(r.fatiasProntas[0].pct).toBe(96);
  });

  it("fatia com volume abaixo do mínimo NÃO é promovida (evita 1/1 = 100%)", () => {
    const r = agregarPlacar([l("2026-08-12", "a", VOLUME_MINIMO_FATIA - 1, 0, 21)], [], AGORA);
    expect(r.fatiasProntas).toHaveLength(0);
  });

  it("aponta o pior cluster de erro do agente (entrada do loop)", () => {
    const erros: LinhaErro[] = [
      { agent_name: "a", oc_sugerida: 56, oc_executada: 54, n: 150 },
      { agent_name: "a", oc_sugerida: 54, oc_executada: 21, n: 35 },
    ];
    const r = agregarPlacar([l("2026-08-12", "a", 5, 5)], erros, AGORA);
    expect(r.agentes[0].piorErro?.oc_sugerida).toBe(56);
    expect(r.agentes[0].piorErro?.n).toBe(150);
  });

  it("acoesParaMeta = quantos acertos a mais faltam pra bater 95%", () => {
    const r = agregarPlacar([l("2026-08-12", "a", 75, 25)], [], AGORA);
    expect(r.global.pct).toBe(75);
    expect(r.acoesParaMeta).toBe(20); // 95 de 100 − 75 já acertados
  });

  it("sem dados → não quebra e não inventa número", () => {
    const r = agregarPlacar([], [], AGORA);
    expect(r.global.pct).toBeNull();
    expect(r.agentes).toHaveLength(0);
    expect(r.acoesParaMeta).toBe(0);
  });
});

describe("vereditoDoAgente — o número vira frase", () => {
  it("volume baixo VENCE o percentual (1 de 1 não é 'pronto pra autonomia')", () => {
    expect(vereditoDoAgente(100, 1).tipo).toBe("pouco");
    expect(vereditoDoAgente(100, VOLUME_CONFIAVEL - 1).tipo).toBe("pouco");
  });

  it("com volume, >= meta vira 'pronto pra soltar'", () => {
    const v = vereditoDoAgente(96.2, 342);
    expect(v.tipo).toBe("pronto");
    expect(v.texto).toBe("pronto pra soltar");
  });

  it("perto da meta (<=15 pts) e longe (>15) têm tons diferentes", () => {
    expect(vereditoDoAgente(84.4, 469).tipo).toBe("perto");
    expect(vereditoDoAgente(63.4, 361).tipo).toBe("atencao");
  });

  it("diz quantos pontos faltam, arredondado", () => {
    expect(vereditoDoAgente(84.4, 469).texto).toBe("11 pts da meta");
  });

  it("sem percentual → volume baixo, nunca quebra", () => {
    expect(vereditoDoAgente(null, 999).tipo).toBe("pouco");
  });
});

describe("porOc — o detalhe que abre ao clicar no agente", () => {
  it("quebra por ocorrência sugerida, PIOR PRIMEIRO (é onde olhar)", () => {
    const linhas = [
      l("2026-08-12", "a", 95, 5, 44),  // 95%
      l("2026-08-12", "a", 10, 90, 56), // 10% ← deve vir primeiro
      l("2026-08-12", "a", 80, 20, 54), // 80%
    ];
    const r = agregarPlacar(linhas, [], AGORA);
    expect(r.agentes[0].porOc.map((o) => o.oc)).toEqual([56, 54, 44]);
    expect(r.agentes[0].porOc[0].pct).toBe(10);
  });

  it("mostra o que o operador fez no lugar, do mais frequente pro menos", () => {
    const erros: LinhaErro[] = [
      { agent_name: "a", oc_card: 11, oc_sugerida: 56, oc_executada: 54, n: 62 },
      { agent_name: "a", oc_card: 10, oc_sugerida: 56, oc_executada: 21, n: 12 },
      { agent_name: "a", oc_card: 10, oc_sugerida: 44, oc_executada: 54, n: 3 },
    ];
    const r = agregarPlacar([l("2026-08-12", "a", 10, 74, 56)], erros, AGORA);
    const oc56 = r.agentes[0].porOc.find((o) => o.oc === 56)!;
    expect(oc56.divergencias.map((d) => d.ocExecutada)).toEqual([54, 21]); // 62 antes de 12
    expect(oc56.divergencias[0].ocCard).toBe(11);
    // divergência de OUTRA oc não vaza pra esta
    expect(oc56.divergencias.some((d) => d.n === 3)).toBe(false);
  });

  it("ocorrência sem divergência aparece com lista vazia (não quebra)", () => {
    const r = agregarPlacar([l("2026-08-12", "a", 40, 0, 44)], [], AGORA);
    expect(r.agentes[0].porOc[0].divergencias).toEqual([]);
    expect(r.agentes[0].porOc[0].pct).toBe(100);
  });
});

describe("montarPerguntaDaOc — do número à pergunta", () => {
  const ocRuim = {
    oc: 54,
    seguidas: 42,
    corrigidas: 200,
    pares: 242,
    pct: 17.4,
    divergencias: [
      { ocExecutada: 21, ocCard: 49, n: 81 },
      { ocExecutada: 44, ocCard: 54, n: 39 },
    ],
  };

  it("leva contexto, números e as trocas reais", () => {
    const p = montarPerguntaDaOc("Leitura da resposta do cliente", ocRuim);
    expect(p).toContain("Leitura da resposta do cliente");
    expect(p).toContain("oc 54");
    expect(p).toContain("17.4%");
    expect(p).toContain("42 de 242");
    expect(p).toContain("com o card em oc 49, lançou oc 21 — 81x");
    expect(p).toContain("com o card em oc 54, lançou oc 44 — 39x");
  });

  it("abaixo da meta → pergunta o PORQUÊ e o que explicar", () => {
    expect(montarPerguntaDaOc("X", ocRuim)).toContain("Por que o agente escolhe");
  });

  it("acima da meta → pergunta o que falta pra liberar autonomia", () => {
    const p = montarPerguntaDaOc("X", { ...ocRuim, pct: 96.2, divergencias: [] });
    expect(p).toContain("liberar como autônoma");
    expect(p).not.toContain("Por que o agente escolhe");
  });

  it("sem divergência não inventa lista vazia", () => {
    const p = montarPerguntaDaOc("X", { ...ocRuim, pct: 100, divergencias: [] });
    expect(p).not.toContain("O que o operador fez no lugar");
  });
});
