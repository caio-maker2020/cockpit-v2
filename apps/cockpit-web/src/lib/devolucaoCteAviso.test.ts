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

  it("nível B sem o nome do arquivo não escreve 'undefined'", () => {
    const a = escolherAvisoDevolucaoCte([ev("DevolucaoCteDetectada", { acao: "sinalizar" })], AGORA);
    expect(a?.tipo).toBe("talvez_cte");
    expect(a?.detalhe).not.toContain("undefined");
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

  // --- GUARD da decisão de 2026-09-02 -------------------------------------
  // O vigia e a cobrança automática foram REMOVIDOS. Estes dois eventos eram
  // emitidos só pelo cron que saiu. Se um refactor futuro os trouxer de volta
  // como aviso, este teste falha — que é o ponto.

  it("os eventos do vigia/cobrança removidos NÃO geram aviso nenhum", () => {
    const removidos = [
      ev("DevolucaoCteCicloParado", { dias_uteis_parado: 9, aviso: "parado" }),
      ev("DevolucaoCteEscalonadaParaHumano", { aviso: "cobrança encerrada" }),
      ev("DevolucaoCteClienteCobrado", { lembrete_numero: 1 }),
      ev("DevolucaoCteCobrancaFalhou", { motivo: "sem_outbound" }),
    ];
    for (const e of removidos) {
      expect(escolherAvisoDevolucaoCte([e], AGORA)).toBeNull();
    }
    // Nem juntos, nem misturados com um evento válido eles vencem a prioridade.
    const a = escolherAvisoDevolucaoCte(
      [...removidos, ev("DevolucaoCteDetectada", { acao: "sinalizar" }, 5)],
      AGORA,
    );
    expect(a?.tipo).toBe("talvez_cte");
  });

  // --- prioridade: um card mostra UM aviso ---------------------------------

  it("vários PDFs vence 'talvez tenha chegado' (risco de documento fiscal errado)", () => {
    const a = escolherAvisoDevolucaoCte(
      [
        ev("DevolucaoCteDetectada", { acao: "sinalizar" }, 1),
        ev("DevolucaoCteAnexoAmbiguo", { anexos: ["x.pdf", "y.pdf"] }, 3),
      ],
      AGORA,
    );
    expect(a?.tipo).toBe("anexo_ambiguo");
    expect(a?.tom).toBe("atencao");
  });

  it("a prioridade NÃO depende da ordem de entrada", () => {
    const eventos = [
      ev("DevolucaoCteAnexoAmbiguo", { anexos: ["x.pdf"] }, 10),
      ev("DevolucaoCteDetectada", { acao: "sinalizar" }, 1),
    ];
    const a = escolherAvisoDevolucaoCte(eventos, AGORA);
    const b = escolherAvisoDevolucaoCte([...eventos].reverse(), AGORA);
    expect(a?.tipo).toBe("anexo_ambiguo");
    expect(b?.tipo).toBe(a?.tipo);
  });

  it("do mesmo tipo, vale o MAIS RECENTE (mesmo com a lista fora de ordem)", () => {
    const a = escolherAvisoDevolucaoCte(
      [
        ev("DevolucaoCteAnexoAmbiguo", { anexos: ["antigo.pdf"] }, 48),
        ev("DevolucaoCteAnexoAmbiguo", { anexos: ["recente.pdf"] }, 2),
      ],
      AGORA,
    );
    expect(a?.detalhe).toContain("recente.pdf");
    expect(a?.detalhe).not.toContain("antigo.pdf");
  });

  // --- janela de relevância -----------------------------------------------

  it("evento velho não avisa mais (presume-se tratado)", () => {
    const velho: EventoDevolucaoCte = {
      event_type: "DevolucaoCteAnexoAmbiguo",
      payload: { anexos: ["x.pdf"] },
      created_at: new Date(AGORA - JANELA_AVISO_MS - 3600_000).toISOString(),
    };
    expect(escolherAvisoDevolucaoCte([velho], AGORA)).toBeNull();
  });

  it("evento na borda da janela ainda avisa", () => {
    const naBorda: EventoDevolucaoCte = {
      event_type: "DevolucaoCteAnexoAmbiguo",
      payload: { anexos: ["x.pdf"] },
      created_at: new Date(AGORA - JANELA_AVISO_MS + 1000).toISOString(),
    };
    expect(escolherAvisoDevolucaoCte([naBorda], AGORA)?.tipo).toBe("anexo_ambiguo");
  });

  it("data ausente ou inválida NÃO avisa (não se afirma nada sem saber quando)", () => {
    for (const created_at of ["", "ontem", "não é data"]) {
      const e = { event_type: "DevolucaoCteAnexoAmbiguo", payload: {}, created_at };
      expect(escolherAvisoDevolucaoCte([e], AGORA)).toBeNull();
    }
  });

  it("payload nulo não derruba o seletor", () => {
    const a = escolherAvisoDevolucaoCte([ev("DevolucaoCteAnexoAmbiguo", null)], AGORA);
    expect(a?.tipo).toBe("anexo_ambiguo");
  });
});
