import { describe, expect, it } from "vitest";
import { agruparKanban, colunaDoItem, COLUNAS_KANBAN_OP, ORDEM_COLUNAS_KANBAN_OP } from "./kanban";
import type { OpFilaLinha, StatusLancamentoOp } from "./tipos";

const l = (p: Partial<OpFilaLinha>): OpFilaLinha => ({ op_item_id: "x", ctrc: "X1", assumido_por: null, lancamento_status: null, ...p }) as OpFilaLinha;

describe("colunas do kanban da Operação", () => {
  it("Nova → Assumida → Na fila do SSW → Lançada → Confirmada, e problema à parte", () => {
    expect(colunaDoItem(l({}))).toBe("nova");
    expect(colunaDoItem(l({ assumido_por: "m" }))).toBe("assumida");
    expect(colunaDoItem(l({ assumido_por: "m", lancamento_status: "fila" }))).toBe("na_fila_ssw");
    expect(colunaDoItem(l({ lancamento_status: "lancando" }))).toBe("na_fila_ssw");
    expect(colunaDoItem(l({ lancamento_status: "lancado" }))).toBe("lancada");
    expect(colunaDoItem(l({ lancamento_status: "confirmado" }))).toBe("confirmada");
    for (const s of ["nao_confirmado", "erro", "recusado"] as StatusLancamentoOp[]) {
      expect(colunaDoItem(l({ assumido_por: "m", lancamento_status: s }))).toBe("problema");
    }
  });
  it("pedido cancelado volta para onde o item está (assumido ou novo)", () => {
    expect(colunaDoItem(l({ lancamento_status: "cancelado" }))).toBe("nova");
    expect(colunaDoItem(l({ assumido_por: "m", lancamento_status: "cancelado" }))).toBe("assumida");
  });
  it("todo status cai em exatamente uma coluna e a ordem de exibição cobre todas", () => {
    expect(new Set(ORDEM_COLUNAS_KANBAN_OP)).toEqual(new Set(COLUNAS_KANBAN_OP.map((c) => c.id)));
    const linhas = [null, "fila", "lancando", "lancado", "confirmado", "nao_confirmado", "recusado", "erro", "cancelado"].map((s, i) =>
      l({ op_item_id: String(i), lancamento_status: s as StatusLancamentoOp | null }),
    );
    const g = agruparKanban(linhas);
    expect(Object.values(g).reduce((a, x) => a + x.length, 0)).toBe(linhas.length);
  });
});
