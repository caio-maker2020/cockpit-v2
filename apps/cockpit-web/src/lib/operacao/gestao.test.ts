import { describe, expect, it } from "vitest";
import { SEM_FILIAL, resumirGestao } from "./gestao";
import type { OpFilaLinha } from "./tipos";

// Quinta, 08/10/2026, 12h em São Paulo.
const AGORA = Date.parse("2026-10-08T15:00:00Z");

let seq = 0;
function linha(p: Partial<OpFilaLinha> = {}): OpFilaLinha {
  seq++;
  return {
    op_item_id: `i${seq}`, ctrc: `C${seq}`, nf: `${seq}`, unidade: "VGA", status: "aberto",
    cod_ultima_ocorrencia: 41, descricao_oc: "INFORMACAO COMPLEMENTAR", data_ultima_ocorrencia: "2026-10-07",
    instrucao_ultima_ocorrencia: null, pagador: "PAGADOR X", destinatario: "DEST Y", cidade_destino: "VARGINHA", uf_destino: "MG",
    previsao_entrega: "2026-10-01", atraso_original: null, qtd_volumes: 2, tipo_cte: "NORMAL", assumido_por: null, assumido_por_nome: null,
    assumido_em: null, sugestao: null, sugestao_em: null, lancamento_id: null, lancamento_status: null,
    lancamento_codigo_oc: null, lancamento_solicitado_por_nome: null, lancamento_solicitado_em: null,
    materializado_em: "2026-10-08T14:50:00Z", updated_at: "2026-10-08T14:50:00Z", ...p,
  };
}

describe("resumo da gestão", () => {
  const ls = [
    linha({ data_ultima_ocorrencia: "2026-09-25" }), // 9 úteis: crítica, acima 7, SLA crítico
    linha({ data_ultima_ocorrencia: "2026-10-02" }), // 4 úteis: parada > 2, SLA fora
    linha({ unidade: "BHZ", cod_ultima_ocorrencia: 36, data_ultima_ocorrencia: "2026-10-06" }), // pré-entrega 2 úteis
    linha({ unidade: null, cod_ultima_ocorrencia: 99, data_ultima_ocorrencia: null }), // sem filial, sem setor, sem data
    linha({ unidade: "ZZZ", cod_ultima_ocorrencia: 31 }), // agendamento, sigla sem regional
  ];
  const r = resumirGestao(ls, AGORA);

  it("nada some: sem setor, sem filial e sem data aparecem", () => {
    expect(r.total).toBe(5);
    expect(r.semSetor).toBe(1);
    expect(r.semFilial).toBe(1);
    expect(r.semData).toBe(1);
    expect(r.porSetor.at(-1)!.nome).toBe("Sem setor");
    expect(r.porFilial.at(-1)!.unidade).toBe(SEM_FILIAL);
    expect(r.porRegional.map((x) => x.regional)).toContain("Sem regional");
  });

  it("setor × filial, gargalos e SLA", () => {
    const op = r.porSetor.find((s) => s.setor === "OPERACAO")!;
    expect(op.total).toBe(3);
    expect(op.sla).toEqual({ dentro: 1, fora: 1, critico: 1 });
    expect(op.mediana).toBe(4);
    expect(r.gargalos[0]).toMatchObject({ unidade: "VGA", setor: "OPERACAO", paradas: 2, foraPrazo: 2, maiorDias: 9 });
    expect(r.gargalos[0]!.itens).toEqual([ls[0]!.op_item_id, ls[1]!.op_item_id]);
    expect(r.matriz.find((c) => c.unidade === "BHZ")).toMatchObject({ setor: "OPERACAO", total: 1, paradas: 0 });
    expect(r.porFilial[0]).toMatchObject({ unidade: "VGA", base: "VARGINHA", regional: "Bruno" });
  });

  it("cargas críticas, faixas e indicadores da regra atual", () => {
    expect(r.criticas.map((n) => n.l.op_item_id)).toEqual([ls[0]!.op_item_id]);
    expect(r.faixas.find((f) => f.id === "8+")!.total).toBe(1);
    expect(r.faixas.reduce((a, f) => a + f.total, 0)).toBe(4); // a sem data fica fora das faixas
    expect(r.indicadores).toEqual({ acima7: 1, baseAcima7: 2, preEntregaAcima2: 1, basePreEntrega: 1 });
  });

  it("régua da carga parada e conselheiro", () => {
    expect(r.cargaParada.entram).toBe(1); // a pré-entrega de BHZ com previsão vencida
    expect(r.cargaParada.porGrupo["Pré-entrega"]).toBe(1);
    expect(r.avisos[0]!.id).toBe("criticas");
    expect(r.avisos.map((a) => a.id)).toEqual(expect.arrayContaining(["sem-setor", "sem-filial"]));
  });

  it("produtividade conta só os lançamentos de hoje", () => {
    const p = resumirGestao(
      [
        linha({ assumido_por_nome: "Ana" }),
        linha({ lancamento_solicitado_por_nome: "Ana", lancamento_solicitado_em: "2026-10-08T13:00:00Z", lancamento_status: "confirmado" }),
        linha({ lancamento_solicitado_por_nome: "Ana", lancamento_solicitado_em: "2026-10-07T13:00:00Z", lancamento_status: "confirmado" }),
        linha({ lancamento_solicitado_por_nome: "Bia", lancamento_solicitado_em: "2026-10-08T12:00:00Z", lancamento_status: "fila" }),
      ],
      AGORA,
    ).produtividade;
    expect(p).toEqual([
      { pessoa: "Ana", assumidas: 1, naFila: 0, lancados: 0, confirmados: 1 },
      { pessoa: "Bia", assumidas: 0, naFila: 1, lancados: 0, confirmados: 0 },
    ]);
  });

  it("filial com muita nota antiga vira aviso", () => {
    const g = [1, 2, 3].map(() => linha({ unidade: "POA", data_ultima_ocorrencia: "2026-09-20" }));
    const avisos = resumirGestao(g, AGORA).avisos;
    expect(avisos.find((a) => a.id === "filial-7d-POA")?.titulo).toBe("POA: 3 de 3 notas com 7 dias úteis ou mais");
  });
});

describe("painel regional", () => {
  it("total, idade média em dias úteis e mais de 5 dias, na ordem das regionais; sem regional por último", () => {
    const r = resumirGestao(
      [
        linha({ unidade: "VGA", data_ultima_ocorrencia: "2026-09-25" }), // 9 úteis
        linha({ unidade: "VGA", data_ultima_ocorrencia: "2026-10-07" }), // 1 útil
        linha({ unidade: "VGA", data_ultima_ocorrencia: null }), // sem data: conta no total, fora da média
        linha({ unidade: "AJF", data_ultima_ocorrencia: "2026-10-05" }), // 3 úteis, Daiene
        linha({ unidade: "ZZZ", data_ultima_ocorrencia: "2026-10-07" }),
      ],
      AGORA,
    );
    expect(r.porRegional.map((g) => g.regional)).toEqual(["Daiene", "Bruno", "Sem regional"]);
    const bruno = r.porRegional.find((g) => g.regional === "Bruno")!;
    expect(bruno).toMatchObject({ total: 3, idadeMedia: 5, acima5: 1 });
    expect(bruno.porBase).toEqual([{ base: "VARGINHA", total: 3, idadeMedia: 5, acima5: 1 }]);
    expect(r.porRegional.at(-1)!.porBase[0]!.base).toBe("ZZZ");
  });
});

describe("pré-entrega no resumo", () => {
  it("vem junto do resumo da gestão", () => {
    const r = resumirGestao([linha({ cod_ultima_ocorrencia: 36, previsao_entrega: "2026-10-09" })], AGORA);
    expect(r.preEntrega).toMatchObject({ total: 1, proximoDiaUtil: "2026-10-09", obrigatorias: { notas: 1, volumes: 2 } });
  });
});
