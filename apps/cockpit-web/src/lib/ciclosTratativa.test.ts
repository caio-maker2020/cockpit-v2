// Guard dos CICLOS (Caio 25/08: "precisa ser correto") — casos REAIS travados.
import { describe, expect, it } from "vitest";
import { aberturasValidas, atribuirCiclo, rotuloCiclo, EVENTOS_ABERTURA_CICLO } from "./ciclosTratativa";

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

  it("eventos de abertura: entrada/reabertura no relacionamento + 49 autônoma; extravio 6/9/16 NÃO abre (INV-168)", () => {
    for (const e of ["BastaoCardImportado", "BastaoReabriuNFFonteRelacionamento", "CardReaberto", "CardReabertoPorRespostaCliente", "AgenteExtravioLancou49"]) {
      expect(EVENTOS_ABERTURA_CICLO).toContain(e);
    }
    expect(EVENTOS_ABERTURA_CICLO).not.toContain("ExtravioImportado");
  });
});

// Regras do Caio 05/10 (INV-168) — casos REAIS travados.
describe("aberturasValidas", () => {
  const ab = (iso: string, tipo = "CardReaberto", paraState: string | null = null) => ({ ts: T(iso), tipo, paraState });
  const ac = (iso: string, codigo: number) => ({ ts: T(iso), codigo });

  it("NF 5004 (real): 3 ciclos — as voltas 54→49 dentro da passagem não abrem ciclo", () => {
    const aberturas = [
      ab("2026-08-10T17:00:00Z", "BastaoCardImportado"),
      ab("2026-09-23T16:30:00Z"),
      ab("2026-09-24T18:31:00Z"),
    ];
    const acoes = [ac("2026-08-14T18:47:00Z", 59), ac("2026-09-22T18:13:00Z", 41), ac("2026-09-23T18:57:00Z", 56), ac("2026-09-24T19:15:00Z", 54)];
    expect(aberturasValidas(aberturas, acoes)).toHaveLength(3);
  });

  it("oc 57 (real): reaberturas seguidas SEM ação no meio = 1 ciclo, não 90", () => {
    const aberturas = Array.from({ length: 90 }, (_, i) => ab(new Date(T("2026-09-05T12:00:00Z") + i * 8 * 3600_000).toISOString()));
    expect(aberturasValidas(aberturas, [])).toHaveLength(1);
  });

  it("reabertura só abre ciclo novo quando houve ação executada desde a anterior", () => {
    const aberturas = [ab("2026-09-01T10:00:00Z", "BastaoCardImportado"), ab("2026-09-03T10:00:00Z"), ab("2026-09-05T10:00:00Z")];
    expect(aberturasValidas(aberturas, [ac("2026-09-02T10:00:00Z", 21)])).toEqual([T("2026-09-01T10:00:00Z"), T("2026-09-03T10:00:00Z")]);
  });

  it("extravio: a 49 autônoma abre o ciclo e absorve a reabertura que o sync registra em seguida", () => {
    const aberturas = [ab("2026-10-01T12:00:00Z", "AgenteExtravioLancou49"), ab("2026-10-01T12:30:00Z")];
    expect(aberturasValidas(aberturas, [ac("2026-10-01T12:01:00Z", 49)])).toEqual([T("2026-10-01T12:00:00Z")]);
  });

  it("card que já teve ciclo no relacionamento e recebe a 49 autônoma: ciclo NOVO", () => {
    const aberturas = [ab("2026-09-20T10:00:00Z", "BastaoCardImportado"), ab("2026-10-01T12:00:00Z", "AgenteExtravioLancou49")];
    expect(aberturasValidas(aberturas, [])).toHaveLength(2);
  });

  it("depois da 49 autônoma, ação diferente de 49 + nova reabertura = ciclo seguinte", () => {
    const aberturas = [ab("2026-10-01T12:00:00Z", "AgenteExtravioLancou49"), ab("2026-10-01T12:30:00Z"), ab("2026-10-04T09:00:00Z")];
    const acoes = [ac("2026-10-01T12:01:00Z", 49), ac("2026-10-02T15:00:00Z", 55)];
    expect(aberturasValidas(aberturas, acoes)).toEqual([T("2026-10-01T12:00:00Z"), T("2026-10-04T09:00:00Z")]);
  });

  it("reabertura que cai em EXTRAVIO_MONITORADO não abre ciclo", () => {
    const aberturas = [ab("2026-09-01T10:00:00Z", "BastaoCardImportado"), ab("2026-09-03T10:00:00Z", "CardReaberto", "EXTRAVIO_MONITORADO")];
    expect(aberturasValidas(aberturas, [ac("2026-09-02T10:00:00Z", 54)])).toHaveLength(1);
  });
});
