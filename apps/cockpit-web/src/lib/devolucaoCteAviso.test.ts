import { describe, expect, it } from "vitest";
import {
  escolherAvisoDevolucaoCte,
  type EventoDevolucaoCte,
  JANELA_AVISO_MS,
} from "./devolucaoCteAviso";

const AGORA = new Date("2026-09-02T18:00:00Z").getTime();
const horasAtras = (h: number) => new Date(AGORA - h * 3600_000).toISOString();

function ev(
  event_type: string,
  payload: Record<string, unknown> | null = {},
  horas = 1,
): EventoDevolucaoCte {
  return { event_type, payload, created_at: horasAtras(horas) };
}

describe("escolherAvisoDevolucaoCte", () => {
  it("sem eventos ⇒ nenhum aviso (card comum não ganha ruído)", () => {
    expect(escolherAvisoDevolucaoCte([], AGORA)).toBeNull();
    expect(escolherAvisoDevolucaoCte([ev("OutroEventoQualquer")], AGORA)).toBeNull();
  });

  it("nível B (sinalizar) vira aviso INFO — nunca proposta (decisão nº 9)", () => {
    const a = escolherAvisoDevolucaoCte(
      [ev("DevolucaoCteDetectada", { acao: "sinalizar", anexo_escolhido_nome: "60022.pdf" })],
      AGORA,
    );
    expect(a?.tipo).toBe("talvez_cte");
    expect(a?.tom).toBe("info");
    expect(a?.detalhe).toContain("60022.pdf");
  });

  it("nível A (propor) NÃO gera aviso — a decisão é a proposta, não um banner", () => {
    const a = escolherAvisoDevolucaoCte(
      [ev("DevolucaoCteDetectada", { acao: "propor", nivel: "A" })],
      AGORA,
    );
    expect(a).toBeNull();
  });

  it("modo sombra NÃO gera aviso — sombra é observação, não pode alterar a tela", () => {
    const a = escolherAvisoDevolucaoCte(
      [ev("DevolucaoCteDetectada", { acao: "sombra", nivel: "A" })],
      AGORA,
    );
    expect(a).toBeNull();
  });

  it("ciclo parado mostra os dias e o texto do backend", () => {
    const a = escolherAvisoDevolucaoCte(
      [ev("DevolucaoCteCicloParado", { dias_uteis_parado: 7, aviso: "Confira a unidade." })],
      AGORA,
    );
    expect(a?.tipo).toBe("ciclo_parado");
    expect(a?.titulo).toContain("7");
    expect(a?.detalhe).toBe("Confira a unidade.");
  });

  it("sem os dias no payload, o título não vira 'null dia(s)'", () => {
    const a = escolherAvisoDevolucaoCte([ev("DevolucaoCteCicloParado", {})], AGORA);
    expect(a?.titulo).toBe("Devolução parada");
    expect(a?.titulo).not.toContain("null");
    expect(a?.detalhe).not.toContain("undefined");
  });

  it("anexo ambíguo lista os arquivos (é o que a operadora usa pra escolher)", () => {
    const a = escolherAvisoDevolucaoCte(
      [ev("DevolucaoCteAnexoAmbiguo", { anexos: ["cte.pdf", "nfd.pdf"] })],
      AGORA,
    );
    expect(a?.tipo).toBe("anexo_ambiguo");
    expect(a?.detalhe).toContain("cte.pdf");
    expect(a?.detalhe).toContain("nfd.pdf");
  });

  it("anexo ambíguo sem lista não quebra o texto", () => {
    const a = escolherAvisoDevolucaoCte([ev("DevolucaoCteAnexoAmbiguo", {})], AGORA);
    expect(a?.tipo).toBe("anexo_ambiguo");
    expect(a?.detalhe).not.toContain("undefined");
  });

  // --- prioridade: um card mostra UM aviso ---------------------------------

  it("cobrança encerrada vence tudo (a automação desistiu; sem humano ninguém age)", () => {
    const a = escolherAvisoDevolucaoCte(
      [
        ev("DevolucaoCteDetectada", { acao: "sinalizar" }, 1),
        ev("DevolucaoCteAnexoAmbiguo", { anexos: ["x.pdf"] }, 2),
        ev("DevolucaoCteCicloParado", { dias_uteis_parado: 9 }, 3),
        ev("DevolucaoCteEscalonadaParaHumano", { aviso: "parou" }, 4),
      ],
      AGORA,
    );
    expect(a?.tipo).toBe("cobranca_encerrada");
    expect(a?.tom).toBe("urgente");
  });

  it("ciclo parado vence 'talvez tenha chegado'", () => {
    const a = escolherAvisoDevolucaoCte(
      [
        ev("DevolucaoCteDetectada", { acao: "sinalizar" }, 1),
        ev("DevolucaoCteCicloParado", { dias_uteis_parado: 6 }, 5),
      ],
      AGORA,
    );
    expect(a?.tipo).toBe("ciclo_parado");
  });

  it("a prioridade NÃO depende da ordem de entrada", () => {
    const eventos = [
      ev("DevolucaoCteEscalonadaParaHumano", { aviso: "parou" }, 10),
      ev("DevolucaoCteDetectada", { acao: "sinalizar" }, 1),
    ];
    const a = escolherAvisoDevolucaoCte(eventos, AGORA);
    const b = escolherAvisoDevolucaoCte([...eventos].reverse(), AGORA);
    expect(a?.tipo).toBe("cobranca_encerrada");
    expect(b?.tipo).toBe(a?.tipo);
  });

  it("do mesmo tipo, vale o MAIS RECENTE (mesmo com a lista fora de ordem)", () => {
    const a = escolherAvisoDevolucaoCte(
      [
        ev("DevolucaoCteCicloParado", { dias_uteis_parado: 3 }, 48),
        ev("DevolucaoCteCicloParado", { dias_uteis_parado: 8 }, 2),
      ],
      AGORA,
    );
    expect(a?.titulo).toContain("8");
  });

  // --- janela de relevância -----------------------------------------------

  it("evento velho não avisa mais (presume-se tratado)", () => {
    const velho: EventoDevolucaoCte = {
      event_type: "DevolucaoCteCicloParado",
      payload: { dias_uteis_parado: 4 },
      created_at: new Date(AGORA - JANELA_AVISO_MS - 3600_000).toISOString(),
    };
    expect(escolherAvisoDevolucaoCte([velho], AGORA)).toBeNull();
  });

  it("evento na borda da janela ainda avisa", () => {
    const naBorda: EventoDevolucaoCte = {
      event_type: "DevolucaoCteCicloParado",
      payload: { dias_uteis_parado: 4 },
      created_at: new Date(AGORA - JANELA_AVISO_MS + 1000).toISOString(),
    };
    expect(escolherAvisoDevolucaoCte([naBorda], AGORA)?.tipo).toBe("ciclo_parado");
  });

  it("data ausente ou inválida NÃO avisa (não se afirma atraso sem saber quando)", () => {
    for (const created_at of ["", "ontem", "não é data"]) {
      const e = { event_type: "DevolucaoCteCicloParado", payload: {}, created_at };
      expect(escolherAvisoDevolucaoCte([e], AGORA)).toBeNull();
    }
  });

  it("payload nulo não derruba o seletor", () => {
    const a = escolherAvisoDevolucaoCte([ev("DevolucaoCteCicloParado", null)], AGORA);
    expect(a?.tipo).toBe("ciclo_parado");
  });
});
