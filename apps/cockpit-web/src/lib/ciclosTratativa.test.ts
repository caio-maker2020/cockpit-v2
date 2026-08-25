// Guard dos CICLOS (Caio 25/08: "precisa ser correto") — casos REAIS travados.
import { describe, expect, it } from "vitest";
import { atribuirCiclo, rotuloCiclo, EVENTOS_ABERTURA_CICLO } from "./ciclosTratativa";

const T = (s: string) => new Date(s).getTime();

describe("atribuirCiclo", () => {
  it("NF 234381 (real): 1 entrada, 3 etapas — a divergência foi ciclo 1, etapa 2", () => {
    const aberturas = [T("2026-08-01T10:00:00Z")];
    const pares = [T("2026-08-05T18:00:00Z"), T("2026-08-10T12:07:00Z"), T("2026-08-12T22:20:00Z")];
    const p = atribuirCiclo(aberturas, pares, pares[1]!);
    expect(p).toEqual({ ciclo: 1, totalCiclos: 1, etapa: 2, etapasNoCiclo: 3 });
    expect(rotuloCiclo(p)).toBe("ciclo 1/1 · etapa 2/3");
  });

  it("exemplo do Caio (25/08): 2 passagens com 2 decisões cada", () => {
    // ciclo 1: entrou oc10 → 54 (e1) → 21 (e2) → saiu; ciclo 2: voltou → 54 (e1) → 44 (e2)
    const aberturas = [T("2026-08-01T08:00:00Z"), T("2026-08-10T08:00:00Z")];
    const pares = [
      T("2026-08-01T09:00:00Z"), T("2026-08-03T09:00:00Z"),
      T("2026-08-10T09:00:00Z"), T("2026-08-12T09:00:00Z"),
    ];
    expect(atribuirCiclo(aberturas, pares, pares[0]!)).toEqual({ ciclo: 1, totalCiclos: 2, etapa: 1, etapasNoCiclo: 2 });
    expect(atribuirCiclo(aberturas, pares, pares[1]!)).toEqual({ ciclo: 1, totalCiclos: 2, etapa: 2, etapasNoCiclo: 2 });
    expect(atribuirCiclo(aberturas, pares, pares[2]!)).toEqual({ ciclo: 2, totalCiclos: 2, etapa: 1, etapasNoCiclo: 2 });
    expect(atribuirCiclo(aberturas, pares, pares[3]!)).toEqual({ ciclo: 2, totalCiclos: 2, etapa: 2, etapasNoCiclo: 2 });
  });

  it("NF 306070 (real): 1 entrada de extravio, 2 etapas (55 e depois 44)", () => {
    const aberturas = [T("2026-08-06T16:30:00Z")];
    const pares = [T("2026-08-12T11:34:00Z"), T("2026-08-13T01:01:00Z")];
    expect(atribuirCiclo(aberturas, pares, pares[1]!)).toEqual({ ciclo: 1, totalCiclos: 1, etapa: 2, etapasNoCiclo: 2 });
  });

  it("bordas: sem abertura registrada (legado) → 1/1; par antes da 1ª abertura → ciclo 1", () => {
    expect(atribuirCiclo([], [T("2026-08-01T10:00:00Z")], T("2026-08-01T10:00:00Z")).ciclo).toBe(1);
    const p = atribuirCiclo([T("2026-08-02T00:00:00Z")], [T("2026-08-01T10:00:00Z")], T("2026-08-01T10:00:00Z"));
    expect(p.ciclo).toBe(1);
  });

  it("eventos de abertura cobrem entrada E reaberturas", () => {
    for (const e of ["BastaoCardImportado", "ExtravioImportado", "BastaoReabriuNFFonteRelacionamento", "CardReaberto", "CardReabertoPorRespostaCliente"]) {
      expect(EVENTOS_ABERTURA_CICLO).toContain(e);
    }
  });
});
