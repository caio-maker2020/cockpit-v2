import { describe, expect, it } from "vitest";
import { SETORES, SETORES_DA_OPERACAO, nomeDoSetor, setorDaOcorrencia, setorDoItem } from "./setores";

// Guard (ADR 0042): o mapa do Pendências (src/types/pendencia.ts:63-86 @a884368).
describe("setores do Pendências", () => {
  it("cada código tem um único setor e o mapa cobre 1..60 menos os sem cadastro", () => {
    const vistos = new Map<number, string>();
    for (const s of SETORES) for (const c of s.codigos) {
      expect(vistos.has(c), `código ${c} em dois setores`).toBe(false);
      vistos.set(c, s.id);
    }
    expect(vistos.size).toBe(60);
  });
  it("casos ancorados: 52 Operação, 60 Cliente, 31 Agendamento, 49 Relacionamento", () => {
    expect(setorDaOcorrencia(52)).toBe("OPERACAO");
    expect(setorDaOcorrencia("60")).toBe("CLIENTE");
    expect(setorDaOcorrencia("031")).toBe("AGENDAMENTO");
    expect(setorDaOcorrencia(49)).toBe("RELACIONAMENTO");
    expect(setorDaOcorrencia(61)).toBe("NAO_IDENTIFICADO");
    expect(setorDaOcorrencia(null)).toBe("NAO_IDENTIFICADO");
  });
  it("responsavel_atual manda; valor desconhecido vira NAO_IDENTIFICADO", () => {
    expect(setorDoItem({ responsavel_atual: "devolucao", cod_ultima_ocorrencia: 13 })).toBe("DEVOLUCAO");
    expect(setorDoItem({ responsavel_atual: "Operação", cod_ultima_ocorrencia: 31 })).toBe("OPERACAO");
    expect(setorDoItem({ responsavel_atual: "financeiro", cod_ultima_ocorrencia: 31 })).toBe("NAO_IDENTIFICADO");
    expect(setorDoItem({ responsavel_atual: null, cod_ultima_ocorrencia: 31 })).toBe("AGENDAMENTO");
    expect(setorDoItem({ setor: "PERDAS", cod_ultima_ocorrencia: 13 })).toBe("PERDAS");
  });
  it("o Relacionamento nunca é setor da Operação", () => {
    expect(SETORES_DA_OPERACAO).not.toContain("RELACIONAMENTO");
    expect(nomeDoSetor("NAO_IDENTIFICADO")).toBe("Sem setor");
  });
});
