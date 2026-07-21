/**
 * Guard anti-regressão — separação 54/59 (Caio 2026-07-13; NF 292727 KAROLINE /
 * NF 143905 DUILIO, 2026-07-21).
 *
 * Propriedade protegida: card em AGUARDANDO_VALIDACAO_HUMANA com
 * cliente_respondeu_em preenchido e oc ∈ OCS_AGUARDANDO_CLIENTE ({54,59}) cai na
 * coluna CLIENTE RESPONDEU — nunca em "Aguardando você". O bug original era o
 * hardcode `=== 54` nas colunas do kanban: a oc 59 (RETORNO INDENIZAÇÃO, split
 * da 54) respondida ficava presa em "Aguardando você".
 */
import { describe, expect, it } from "vitest";
import { KANBAN_COLUMNS, OCS_AGUARDANDO_CLIENTE } from "./types";

type MatchInput = Parameters<(typeof KANBAN_COLUMNS)[number]["match"]>[0];

function cardStub(overrides: Partial<MatchInput>): MatchInput {
  return {
    state: "AGUARDANDO_VALIDACAO_HUMANA",
    aprovacao_modo: null,
    lock_aguardando_validacao: true,
    cliente_respondeu_em: null,
    cod_ultima_ocorrencia: null,
    ...overrides,
  } as MatchInput;
}

function colunaDe(card: MatchInput): string | undefined {
  return KANBAN_COLUMNS.find((c) => c.match(card))?.id;
}

describe("kanban 54/59 — coluna CLIENTE RESPONDEU", () => {
  it("OCS_AGUARDANDO_CLIENTE contém exatamente {54, 59}", () => {
    expect([...OCS_AGUARDANDO_CLIENTE].sort()).toEqual([54, 59]);
  });

  it("oc 59 respondida → cliente_respondeu (caso NF 292727)", () => {
    const col = colunaDe(
      cardStub({ cod_ultima_ocorrencia: 59, cliente_respondeu_em: "2026-07-21T17:12:56Z" }),
    );
    expect(col).toBe("cliente_respondeu");
  });

  it("oc 54 respondida → cliente_respondeu (regressão: 54 não muda)", () => {
    const col = colunaDe(
      cardStub({ cod_ultima_ocorrencia: 54, cliente_respondeu_em: "2026-07-21T10:00:00Z" }),
    );
    expect(col).toBe("cliente_respondeu");
  });

  it("oc 59 SEM resposta em AVH → validacao (não vaza pra cliente_respondeu)", () => {
    const col = colunaDe(cardStub({ cod_ultima_ocorrencia: 59 }));
    expect(col).toBe("validacao");
  });

  it("oc de relacionamento (ex. 20) respondida → validacao (comportamento preservado)", () => {
    const col = colunaDe(
      cardStub({ cod_ultima_ocorrencia: 20, cliente_respondeu_em: "2026-07-21T10:00:00Z" }),
    );
    expect(col).toBe("validacao");
  });

  it("oc null respondida → validacao (sem crash com cod_ultima_ocorrencia null)", () => {
    const col = colunaDe(
      cardStub({ cod_ultima_ocorrencia: null, cliente_respondeu_em: "2026-07-21T10:00:00Z" }),
    );
    expect(col).toBe("validacao");
  });
});
