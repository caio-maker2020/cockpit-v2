import { describe, expect, it } from "vitest";
import {
  diasUteisFechados,
  isFimDeSemana,
  totaisJanela,
  type LinhaMetricaDiaria,
} from "./aprendizadoPlacar";

// Quinta-feira 2026-08-13 como "agora" (data fixa: o placar é sensível a data).
const AGORA = new Date("2026-08-13T15:00:00Z");

const linha = (
  dia: string,
  seguidas: number,
  corrigidas: number,
  agent_name = "agente-a",
): LinhaMetricaDiaria => ({ dia, agent_name, pares: seguidas + corrigidas, seguidas, corrigidas });

describe("janela de dias úteis", () => {
  it("pula fim de semana e NÃO inclui hoje (dia ainda aberto)", () => {
    const dias = diasUteisFechados(7, AGORA);
    expect(dias).toHaveLength(7);
    expect(dias).not.toContain("2026-08-13"); // hoje
    expect(dias[0]).toBe("2026-08-12"); // quarta
    expect(dias.some(isFimDeSemana)).toBe(false);
    // 7 úteis a partir de qui/13 retrocede até quinta da semana anterior
    expect(dias[6]).toBe("2026-08-04");
  });

  it("as duas janelas (recente e anterior) não se sobrepõem", () => {
    const d = diasUteisFechados(14, AGORA);
    const rec = new Set(d.slice(0, 7));
    expect(d.slice(7, 14).some((x) => rec.has(x))).toBe(false);
  });
});

describe("totaisJanela", () => {
  it("soma só a janela recente e compara com a anterior (a melhora)", () => {
    const rows = [
      // recente (últimos 7 úteis): 80% seguidas
      linha("2026-08-12", 8, 2),
      linha("2026-08-11", 8, 2),
      // anterior (7 úteis antes): 50%
      linha("2026-08-03", 5, 5),
      linha("2026-07-31", 5, 5),
    ];
    const t = totaisJanela(rows, "todos", AGORA);
    expect(t.seguidas).toBe(16);
    expect(t.corrigidas).toBe(4);
    expect(t.pct).toBe(80);
    expect(t.pctAnterior).toBe(50);
    expect(t.delta).toBe(30); // melhorou 30 pontos
  });

  it("ignora dias fora das duas janelas (não contamina o placar)", () => {
    const rows = [linha("2026-08-12", 10, 0), linha("2026-06-01", 0, 99)];
    const t = totaisJanela(rows, "todos", AGORA);
    expect(t.corrigidas).toBe(0);
    expect(t.pct).toBe(100);
  });

  it("respeita o filtro de agente da aba", () => {
    const rows = [
      linha("2026-08-12", 9, 1, "agente-a"),
      linha("2026-08-12", 1, 9, "agente-b"),
    ];
    expect(totaisJanela(rows, "todos", AGORA).pct).toBe(50);
    expect(totaisJanela(rows, "agente-a", AGORA).pct).toBe(90);
    expect(totaisJanela(rows, "agente-b", AGORA).pct).toBe(10);
  });

  it("delta fica null quando não há base anterior (não inventa comparação)", () => {
    const t = totaisJanela([linha("2026-08-12", 5, 5)], "todos", AGORA);
    expect(t.pct).toBe(50);
    expect(t.pctAnterior).toBeNull();
    expect(t.delta).toBeNull();
  });

  it("sem dados → pct null, sem divisão por zero", () => {
    const t = totaisJanela([], "todos", AGORA);
    expect(t.pct).toBeNull();
    expect(t.delta).toBeNull();
    expect(t.pares).toBe(0);
  });

  it("percentual usa seguidas/(seguidas+corrigidas) — `pares` não entra na conta", () => {
    // `pares` pode incluir ações ainda não avaliadas; o % é sobre o avaliado.
    const rows = [{ dia: "2026-08-12", agent_name: "x", pares: 100, seguidas: 3, corrigidas: 1 }];
    const t = totaisJanela(rows, "todos", AGORA);
    expect(t.pares).toBe(100);
    expect(t.pct).toBe(75);
  });

  it("arredonda em 1 casa (como o card exibe)", () => {
    const rows = [linha("2026-08-12", 603, 212)]; // proporção real de produção
    expect(totaisJanela(rows, "todos", AGORA).pct).toBe(74);
  });
});
