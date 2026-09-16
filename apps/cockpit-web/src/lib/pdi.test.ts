import { describe, expect, it } from "vitest";
import {
  ehCaioPdi,
  ehParticipantePdi,
  inicioDaSemana,
  resumoDemandaSemanal,
  rotuloDestino,
} from "./pdi";

describe("acesso ao PDI", () => {
  it("só Isadora e Caio participam; ninguém mais vê a aba", () => {
    expect(ehParticipantePdi("isadora.baldoni@salexpress.com.br")).toBe(true);
    expect(ehParticipantePdi("CAIO@salexpress.com.br")).toBe(true);
    expect(ehParticipantePdi("sac@salexpress.com.br")).toBe(false);
    expect(ehParticipantePdi(null)).toBe(false);
  });
  it("ações de gestão (liberar/validar) são só do Caio", () => {
    expect(ehCaioPdi("caio@salexpress.com.br")).toBe(true);
    expect(ehCaioPdi("isadora.baldoni@salexpress.com.br")).toBe(false);
  });
});

describe("mapa de demanda — agregação semanal", () => {
  it("agrupa pela segunda-feira da semana e soma tempo/classes/pendentes", () => {
    // 2026-09-16 é quarta → semana começa 2026-09-14 (segunda)
    const rows = [
      { criado_em: "2026-09-16T10:00:00", tempo_min: 15, classe_causa: "falta_conhecimento", destino: null },
      { criado_em: "2026-09-14T09:00:00", tempo_min: 30, classe_causa: "falta_conhecimento", destino: "vira_conhecimento" },
      { criado_em: "2026-09-18T17:00:00", tempo_min: 5, classe_causa: "excecao", destino: null },
      { criado_em: "2026-09-08T12:00:00", tempo_min: 60, classe_causa: "processo_disfuncional", destino: "vira_projeto" },
    ];
    const r = resumoDemandaSemanal(rows);
    expect(r).toHaveLength(2);
    expect(r[0].semana).toBe("2026-09-14"); // mais recente primeiro
    expect(r[0].acionamentos).toBe(3);
    expect(r[0].tempoMin).toBe(50);
    expect(r[0].porClasse["falta_conhecimento"]).toBe(2);
    expect(r[0].pendentes).toBe(2);
    expect(r[1].semana).toBe("2026-09-07");
  });
  it("domingo pertence à semana que começou na segunda anterior", () => {
    expect(inicioDaSemana("2026-09-20T08:00:00")).toBe("2026-09-14");
    expect(inicioDaSemana("2026-09-14T00:30:00")).toBe("2026-09-14");
  });
});

describe("rótulos", () => {
  it("destino nulo aparece como Pendente", () => {
    expect(rotuloDestino(null)).toBe("Pendente");
    expect(rotuloDestino("vira_alcada")).toBe("Vira alçada");
  });
});
