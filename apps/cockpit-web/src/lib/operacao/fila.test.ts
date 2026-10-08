import { describe, expect, it } from "vitest";
import {
  FILTROS_PADRAO,
  filtrarFila,
  formatarDuracao,
  opcoesDaFila,
  ordenarPorTempoParado,
  situacaoPrazo,
  statusLancamentoTela,
  tempoParadoMs,
} from "./fila";
import type { OpFilaLinha } from "./tipos";

const AGORA = Date.parse("2026-10-07T12:00:00Z");
const H = 3_600_000;

function linha(p: Partial<OpFilaLinha> & { op_item_id: string }): OpFilaLinha {
  return {
    ctrc: `CTRC-${p.op_item_id}`.toUpperCase(),
    nf: "123456",
    unidade: "VGA",
    status: "aberto",
    cod_ultima_ocorrencia: 13,
    descricao_oc: "Entrega impossibilitada: limitação cliente",
    data_ultima_ocorrencia: new Date(AGORA - 10 * H).toISOString(),
    instrucao_ultima_ocorrencia: null,
    pagador: "PAGADOR X",
    destinatario: "DEST Y",
    cidade_destino: "Varginha",
    uf_destino: "MG",
    tipo_cte: "NORMAL",
    previsao_entrega: null,
    atraso_original: null,
    qtd_volumes: 1,
    assumido_por: null,
    assumido_por_nome: null,
    assumido_em: null,
    sugestao: null,
    sugestao_em: null,
    lancamento_id: null,
    lancamento_status: null,
    lancamento_codigo_oc: null,
    lancamento_solicitado_por_nome: null,
    lancamento_solicitado_em: null,
    materializado_em: new Date(AGORA - 60_000).toISOString(),
    updated_at: new Date(AGORA - 60_000).toISOString(),
    ...p,
  };
}

const ctx = { membro: { unidades: ["VGA"] }, agoraMs: AGORA };

describe("relógio da fila (INV-151: nunca o campo que o materializador reescreve)", () => {
  it("mede desde data_ultima_ocorrencia, ignorando materializado_em e updated_at", () => {
    const l = linha({ op_item_id: "a", data_ultima_ocorrencia: new Date(AGORA - 30 * H).toISOString() });
    expect(tempoParadoMs(l, AGORA)).toBe(30 * H);
  });
  it("sem data → null (não inventa 'agora')", () => {
    expect(tempoParadoMs(linha({ op_item_id: "a", data_ultima_ocorrencia: null }), AGORA)).toBeNull();
  });
  it("formata durações", () => {
    expect(formatarDuracao(45 * 60_000)).toBe("45 min");
    expect(formatarDuracao(5 * H)).toBe("5 h");
    expect(formatarDuracao(50 * H)).toBe("2 d 2 h");
    expect(formatarDuracao(48 * H)).toBe("2 d");
    expect(formatarDuracao(null)).toBe("—");
  });
});

describe("ordenação por tempo parado", () => {
  const linhas = [
    linha({ op_item_id: "pouco", data_ultima_ocorrencia: new Date(AGORA - 1 * H).toISOString() }),
    linha({ op_item_id: "sem-data", data_ultima_ocorrencia: null }),
    linha({ op_item_id: "muito", data_ultima_ocorrencia: new Date(AGORA - 90 * H).toISOString() }),
    linha({ op_item_id: "medio", data_ultima_ocorrencia: new Date(AGORA - 20 * H).toISOString() }),
  ];
  it("mais parado primeiro; sem data no fim", () => {
    expect(ordenarPorTempoParado(linhas, AGORA).map((l) => l.op_item_id)).toEqual(["muito", "medio", "pouco", "sem-data"]);
  });
  it("menos parado primeiro; sem data continua no fim", () => {
    expect(ordenarPorTempoParado(linhas, AGORA, "menos_parado").map((l) => l.op_item_id)).toEqual([
      "pouco",
      "medio",
      "muito",
      "sem-data",
    ]);
  });
  it("não muta a entrada", () => {
    const copia = [...linhas];
    ordenarPorTempoParado(linhas, AGORA);
    expect(linhas).toEqual(copia);
  });
});

describe("status do lançamento na tela", () => {
  it("mapeia o status do banco para o vocabulário da tela", () => {
    expect(statusLancamentoTela("fila")).toBe("na_fila");
    expect(statusLancamentoTela("lancando")).toBe("lancando");
    expect(statusLancamentoTela("lancado")).toBe("lancado");
    expect(statusLancamentoTela("confirmado")).toBe("confirmado");
    expect(statusLancamentoTela("nao_confirmado")).toBe("nao_confirmado");
    expect(statusLancamentoTela("erro")).toBe("erro");
    expect(statusLancamentoTela("recusado")).toBe("erro");
    expect(statusLancamentoTela("cancelado")).toBe("sem_lancamento");
    expect(statusLancamentoTela(null)).toBe("sem_lancamento");
  });
});

describe("filtros", () => {
  const linhas = [
    linha({ op_item_id: "vga-13", unidade: "VGA", cod_ultima_ocorrencia: 13, cidade_destino: "Varginha" }),
    linha({
      op_item_id: "poa-36",
      unidade: "POA",
      cod_ultima_ocorrencia: 36,
      cidade_destino: "Itajubá",
      data_ultima_ocorrencia: new Date(AGORA - 80 * H).toISOString(),
      sugestao: { regra_id: "r", codigo: 15, texto: "t", motivo: "m", lancavel: true },
    }),
    linha({ op_item_id: "sem-unidade", unidade: null, cod_ultima_ocorrencia: 56, lancamento_status: "fila", lancamento_id: "l1" }),
    linha({ op_item_id: "bhz-erro", unidade: "BHZ", pagador: "Laticínios Boa Vista", lancamento_status: "recusado" }),
  ];
  const ids = (f: Partial<typeof FILTROS_PADRAO>) =>
    filtrarFila(linhas, { ...FILTROS_PADRAO, ...f }, ctx).map((l) => l.op_item_id);

  it("padrão não esconde nada", () => {
    expect(ids({})).toHaveLength(4);
  });
  it("minhas unidades: só as do cadastro (item sem unidade sai)", () => {
    expect(ids({ minhasUnidades: true })).toEqual(["vga-13"]);
  });
  it("oc", () => {
    expect(ids({ oc: 36 })).toEqual(["poa-36"]);
  });
  it("cidade (rótulo cidade/UF)", () => {
    expect(ids({ cidade: "Itajubá/MG" })).toEqual(["poa-36"]);
  });
  it("tipo de CT-e (Caio 08/10)", () => {
    expect(ids({ tipoCte: "NORMAL" })).toHaveLength(4);
    expect(ids({ tipoCte: "DEVOLUCAO" })).toEqual([]);
  });
  it("tempo parado", () => {
    expect(ids({ tempo: "72h" })).toEqual(["poa-36"]);
    expect(ids({ tempo: "4h" })).toHaveLength(4);
  });
  it("com sugestão", () => {
    expect(ids({ comSugestao: true })).toEqual(["poa-36"]);
  });
  it("status do lançamento", () => {
    expect(ids({ status: "na_fila" })).toEqual(["sem-unidade"]);
    expect(ids({ status: "erro" })).toEqual(["bhz-erro"]);
    expect(ids({ status: "sem_lancamento" })).toEqual(["vga-13", "poa-36"]);
  });
  it("busca sem acento e sem caixa, por NF/CTRC/pagador", () => {
    expect(ids({ busca: "laticinios" })).toEqual(["bhz-erro"]);
    expect(ids({ busca: "ctrc-poa-36" })).toEqual(["poa-36"]);
  });
  it("filtros combinam (E)", () => {
    expect(ids({ oc: 13, minhasUnidades: true, busca: "nada-a-ver" })).toEqual([]);
  });
});

describe("opções e prazo", () => {
  it("opções vêm da própria fila, ordenadas e sem repetição", () => {
    const o = opcoesDaFila([
      linha({ op_item_id: "1", cod_ultima_ocorrencia: 36, cidade_destino: "Lavras" }),
      linha({ op_item_id: "2", cod_ultima_ocorrencia: 13, cidade_destino: "Betim" }),
      linha({ op_item_id: "3", cod_ultima_ocorrencia: 36, cidade_destino: "Lavras" }),
    ]);
    expect(o.ocs.map((x) => x.codigo)).toEqual([13, 36]);
    expect(o.cidades).toEqual(["Betim/MG", "Lavras/MG"]);
    expect(o.tiposCte).toEqual(["NORMAL"]);
  });
  it("atraso do Bastão manda; sem ele, previsão vencida também é atraso", () => {
    expect(situacaoPrazo({ atraso_original: 3, previsao_entrega: null }, AGORA)).toEqual({ texto: "3 d de atraso", atrasado: true });
    expect(situacaoPrazo({ atraso_original: null, previsao_entrega: new Date(AGORA - 30 * H).toISOString() }, AGORA).atrasado).toBe(true);
    expect(situacaoPrazo({ atraso_original: null, previsao_entrega: new Date(AGORA + 30 * H).toISOString() }, AGORA).atrasado).toBe(false);
    expect(situacaoPrazo({ atraso_original: null, previsao_entrega: null }, AGORA).texto).toBe("sem previsão");
  });
});
