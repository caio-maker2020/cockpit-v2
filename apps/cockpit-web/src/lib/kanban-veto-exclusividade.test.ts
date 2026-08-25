// Guard do risco 8 do plano de veto (25/08): todo card ativo casa EXATAMENTE
// UMA coluna do kanban — o trilho autônomo entrou como VISÃO antes das abas
// de origem (primeiro-match-ganha) e não pode roubar nem duplicar card.
// Se este teste quebrar, card some ou aparece em duas abas.
import { describe, expect, it } from "vitest";
import { KANBAN_COLUMNS, type CardRow } from "./types";

const base = (p: Partial<CardRow>): CardRow =>
  ({
    id: "c1",
    state: "AGUARDANDO_VALIDACAO_HUMANA",
    aprovacao_modo: null,
    lock_aguardando_validacao: true,
    cliente_respondeu_em: null,
    cod_ultima_ocorrencia: 10,
    acao_autonoma: null,
    ...p,
  }) as unknown as CardRow;

function colunasQueCasam(c: CardRow): string[] {
  return KANBAN_COLUMNS.filter((col) => col.match(c as never)).map((col) => col.id);
}

/** primeiro-match-ganha: o que o Inbox de fato usa. */
function colunaEfetiva(c: CardRow): string | undefined {
  return KANBAN_COLUMNS.find((col) => col.match(c as never))?.id;
}

describe("exclusividade das colunas com o trilho autônomo", () => {
  it("AVH sem espelho → Aguardando você (como sempre)", () => {
    expect(colunaEfetiva(base({}))).toBe("validacao");
  });

  it("AVH com janela aberta → AÇÃO AUTÔNOMA (rouba da validacao pela ordem)", () => {
    const c = base({
      acao_autonoma: {
        agendamento_id: 1, acao_key: "lancar_ocorrencia:21",
        executar_em: new Date(Date.now() + 30 * 60000).toISOString(),
        status: "pendente", hash_proposta: "x", processed_at: null, cancelado_motivo: null,
      },
    });
    expect(colunaEfetiva(c)).toBe("veto_janela");
  });

  it("CLIENTE RESPONDEU (oc 54) com janela → AÇÃO AUTÔNOMA; sem janela → cliente_respondeu", () => {
    const semJanela = base({ cliente_respondeu_em: "2026-08-25T10:00:00Z", cod_ultima_ocorrencia: 54 });
    expect(colunaEfetiva(semJanela)).toBe("cliente_respondeu");
    const comJanela = base({
      cliente_respondeu_em: "2026-08-25T10:00:00Z",
      cod_ultima_ocorrencia: 54,
      acao_autonoma: {
        agendamento_id: 2, acao_key: "ignorar_e_aguardar:54",
        executar_em: new Date(Date.now() + 10 * 60000).toISOString(),
        status: "pendente", hash_proposta: "x", processed_at: null, cancelado_motivo: null,
      },
    });
    expect(colunaEfetiva(comJanela)).toBe("veto_janela");
  });

  it("espelho cancelado/expirado NÃO segura o card — volta pra aba de origem (risco 1)", () => {
    for (const status of ["cancelado", "expirado", null]) {
      const c = base({
        acao_autonoma: status
          ? { agendamento_id: 3, acao_key: "lancar_ocorrencia:21", executar_em: null,
              status, hash_proposta: null, processed_at: null, cancelado_motivo: "vetado" }
          : null,
      });
      expect(colunaEfetiva(c)).toBe("validacao");
    }
  });

  it("executada CONFIRMADA (<1h) → Autônoma executada; >1h → vida normal (Ação executada)", () => {
    const conf = base({
      state: "ACAO_EXECUTADA",
      aprovacao_modo: "autonoma",
      acao_autonoma: {
        agendamento_id: 4, acao_key: "lancar_ocorrencia:21", executar_em: null,
        status: "processado", hash_proposta: "x",
        processed_at: new Date(Date.now() - 20 * 60000).toISOString(), cancelado_motivo: null,
      },
    });
    expect(colunaEfetiva(conf)).toBe("veto_executada");
    const velha = base({
      state: "ACAO_EXECUTADA",
      aprovacao_modo: "autonoma",
      acao_autonoma: {
        ...(conf.acao_autonoma as NonNullable<CardRow["acao_autonoma"]>),
        processed_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
      },
    });
    expect(colunaEfetiva(velha)).toBe("acao_executada");
  });

  it("EXECUTANDO_ACAO autônoma (gap RPC→SSW) NÃO entra na executada (risco 2) — cai na coluna autônoma antiga", () => {
    const c = base({
      state: "EXECUTANDO_ACAO",
      aprovacao_modo: "autonoma",
      acao_autonoma: {
        agendamento_id: 5, acao_key: "lancar_ocorrencia:21", executar_em: null,
        status: "processado", hash_proposta: "x",
        processed_at: new Date().toISOString(), cancelado_motivo: null,
      },
    });
    expect(colunaEfetiva(c)).toBe("autonoma");
  });

  it("nenhum card ativo casa DUAS colunas cuja ordem importe de forma ambígua além do desenho", () => {
    // amostra representativa: pra cada card, a coluna efetiva é a PRIMEIRA das
    // que casam — e cards com janela casam a do veto antes de qualquer outra.
    const comJanela = base({
      acao_autonoma: {
        agendamento_id: 9, acao_key: "lancar_ocorrencia:21",
        executar_em: new Date().toISOString(), status: "pendente",
        hash_proposta: "x", processed_at: null, cancelado_motivo: null,
      },
    });
    const casam = colunasQueCasam(comJanela);
    expect(casam[0]).toBe("veto_janela");
  });
});
