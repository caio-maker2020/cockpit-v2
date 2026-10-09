import { describe, expect, it } from "vitest";
import {
  COLUNAS_CARGA_PARADA,
  MIN_DIAS_REGRA_AJUDA,
  MIN_DIAS_REGRA_CODIGO,
  campoCsv,
  ehDevolucaoOuReversa,
  linhasCargaParadaCsv,
  regraCargaParada,
  resumirCargaParada,
  resumirPreEntrega,
} from "./cargaParada";
import type { OpFilaLinha } from "./tipos";

const meioDia = (d: string) => Date.parse(`${d}T15:00:00Z`); // 12h em São Paulo
const QUI = meioDia("2026-10-08");
const SEX = meioDia("2026-10-16");
const SEG = meioDia("2026-10-19");

let seq = 0;
function linha(p: Partial<OpFilaLinha> = {}): OpFilaLinha {
  seq++;
  return {
    op_item_id: `i${seq}`, ctrc: `C${seq}`, nf: `${seq}`, unidade: "VGA", status: "aberto",
    cod_ultima_ocorrencia: 36, descricao_oc: "CHEGADA NA BASE", data_ultima_ocorrencia: "2026-10-07",
    instrucao_ultima_ocorrencia: null, pagador: "PAGADOR X", destinatario: "DEST Y", cidade_destino: "VARGINHA", uf_destino: "MG",
    previsao_entrega: "2026-10-01", atraso_original: null, qtd_volumes: 2, tipo_cte: "NORMAL", assumido_por: null, assumido_por_nome: null,
    assumido_em: null, sugestao: null, sugestao_em: null, lancamento_id: null, lancamento_status: null,
    lancamento_codigo_oc: null, lancamento_solicitado_por_nome: null, lancamento_solicitado_em: null,
    materializado_em: "2026-10-08T14:50:00Z", updated_at: "2026-10-08T14:50:00Z", ...p,
  };
}

describe("regra da carga parada: devolução e reversa", () => {
  it("entra só com a última oc 02, sem mínimo de dias e sem olhar a previsão", () => {
    const r = regraCargaParada(linha({ tipo_cte: "DEVOLUCAO", cod_ultima_ocorrencia: 2, data_ultima_ocorrencia: "2026-10-08", previsao_entrega: "2026-12-01" }), QUI);
    expect(r).toMatchObject({ grupo: "Devolução/reversa", minDias: 0, dias: 0, entra: true, motivo: null });
    expect(regraCargaParada(linha({ tipo_cte: "REVERSA", cod_ultima_ocorrencia: 2, data_ultima_ocorrencia: null }), QUI).entra).toBe(true);
  });
  it("com outra oc não entra, mesmo velha e vencida", () => {
    const r = regraCargaParada(linha({ tipo_cte: "DEVOLUÇÃO", cod_ultima_ocorrencia: 36, data_ultima_ocorrencia: "2026-09-01" }), QUI);
    expect(r).toMatchObject({ entra: false, motivo: "dev-rev-sem-oc2" });
  });
  it("reconhece o tipo com e sem acento, em qualquer caixa", () => {
    expect(ehDevolucaoOuReversa("Devolução")).toBe(true);
    expect(ehDevolucaoOuReversa("REVERSA")).toBe(true);
    expect(ehDevolucaoOuReversa("NORMAL")).toBe(false);
    expect(ehDevolucaoOuReversa(null)).toBe(false);
  });
});

describe("regra da carga parada: só NORMAL e fora do prazo", () => {
  it("tipo vazio fica fora como dúvida; outros tipos ficam fora", () => {
    expect(regraCargaParada(linha({ tipo_cte: null }), QUI)).toMatchObject({ entra: false, motivo: "sem-tipo" });
    expect(regraCargaParada(linha({ tipo_cte: "REDESPACHO" }), QUI)).toMatchObject({ entra: false, motivo: "tipo-fora" });
    expect(regraCargaParada(linha({ tipo_cte: "SUBC FORM CTRC" }), QUI)).toMatchObject({ entra: false, motivo: "tipo-fora" });
  });
  it("previsão não vencida não entra; sem previsão é dúvida", () => {
    expect(regraCargaParada(linha({ previsao_entrega: "2026-10-08" }), QUI)).toMatchObject({ entra: false, motivo: "no-prazo" });
    expect(regraCargaParada(linha({ previsao_entrega: null }), QUI)).toMatchObject({ entra: false, motivo: "sem-previsao" });
  });
  it("oc fora dos grupos não entra", () => {
    expect(regraCargaParada(linha({ cod_ultima_ocorrencia: 41, data_ultima_ocorrencia: "2026-09-01" }), QUI)).toMatchObject({ grupo: null, entra: false, motivo: "fora-do-grupo" });
  });
});

describe("regra da carga parada: mínimos por grupo", () => {
  it("pré-entrega com 1+ dia útil (código), não 2 (ajuda)", () => {
    expect(MIN_DIAS_REGRA_CODIGO).toBe(1);
    expect(MIN_DIAS_REGRA_AJUDA).toBe(2);
    for (const c of [7, 13, 15, 21, 36, 39, 55]) {
      expect(regraCargaParada(linha({ cod_ultima_ocorrencia: c, data_ultima_ocorrencia: "2026-10-07" }), QUI)).toMatchObject({ grupo: "Pré-entrega", dias: 1, entra: true });
    }
    expect(regraCargaParada(linha({ data_ultima_ocorrencia: "2026-10-08" }), QUI)).toMatchObject({ entra: false, motivo: "poucos-dias" });
  });
  it("51/52/58 e 56 com 1+ viram 'Informação faltante - resolver rápido'", () => {
    for (const c of [51, 52, 56, 58]) {
      expect(regraCargaParada(linha({ cod_ultima_ocorrencia: c, data_ultima_ocorrencia: "2026-10-07" }), QUI)).toMatchObject({
        grupo: "Informação faltante - resolver rápido",
        entra: true,
      });
      expect(regraCargaParada(linha({ cod_ultima_ocorrencia: c, data_ultima_ocorrencia: "2026-10-08" }), QUI).entra).toBe(false);
    }
  });
  it("40 (redespacho final) só com 3+ dias úteis desde a última ocorrência", () => {
    expect(regraCargaParada(linha({ cod_ultima_ocorrencia: 40, data_ultima_ocorrencia: "2026-10-06" }), QUI)).toMatchObject({ dias: 2, entra: false });
    expect(regraCargaParada(linha({ cod_ultima_ocorrencia: 40, data_ultima_ocorrencia: "2026-10-05" }), QUI)).toMatchObject({ dias: 3, entra: true, grupo: "Redespacho final" });
  });
});

describe("regra da carga parada: dias úteis", () => {
  it("sexta → segunda conta 1 dia útil (fim de semana não conta)", () => {
    expect(regraCargaParada(linha({ data_ultima_ocorrencia: "2026-10-16" }), SEG)).toMatchObject({ dias: 1, entra: true });
    // 40: quarta 14 → segunda 19 = qui, sex, seg = 3; quinta 15 → segunda = 2.
    expect(regraCargaParada(linha({ cod_ultima_ocorrencia: 40, data_ultima_ocorrencia: "2026-10-14" }), SEG).entra).toBe(true);
    expect(regraCargaParada(linha({ cod_ultima_ocorrencia: 40, data_ultima_ocorrencia: "2026-10-15" }), SEG).entra).toBe(false);
  });
  it("feriado nacional não conta (segunda 12/10/2026)", () => {
    expect(regraCargaParada(linha({ data_ultima_ocorrencia: "2026-10-09" }), meioDia("2026-10-12"))).toMatchObject({ dias: 0, entra: false });
    expect(regraCargaParada(linha({ data_ultima_ocorrencia: "2026-10-09" }), meioDia("2026-10-13"))).toMatchObject({ dias: 1, entra: true });
  });
});

describe("resumo e CSV da carga parada", () => {
  const ls = [
    linha({ unidade: "VGA", cod_ultima_ocorrencia: 40, data_ultima_ocorrencia: "2026-10-01" }),
    linha({ unidade: "VGA", cod_ultima_ocorrencia: 36, data_ultima_ocorrencia: "2026-10-05", instrucao_ultima_ocorrencia: "AGUARDA; CLIENTE" }),
    linha({ unidade: "VGA", cod_ultima_ocorrencia: 36, data_ultima_ocorrencia: "2026-10-06" }),
    linha({ unidade: "AJF", tipo_cte: "REVERSA", cod_ultima_ocorrencia: 2 }),
    linha({ unidade: "AJF", cod_ultima_ocorrencia: 52 }),
    linha({ unidade: null, cod_ultima_ocorrencia: 13 }),
    linha({ tipo_cte: null }), // dúvida
    linha({ previsao_entrega: null }), // dúvida
    linha({ cod_ultima_ocorrencia: 41 }), // fora
  ];

  it("conta por grupo, bases e dúvidas", () => {
    expect(resumirCargaParada(ls, QUI)).toEqual({
      entram: 6,
      bases: 3,
      porGrupo: { "Pré-entrega": 3, "Informação faltante - resolver rápido": 1, "Redespacho final": 1, "Devolução/reversa": 1 },
      semTipo: 1,
      semPrevisao: 1,
    });
  });

  it("um arquivo com a coluna Base, bases em ordem e, dentro da base, grupo e a oc mais recente", () => {
    const [cab, ...rest] = linhasCargaParadaCsv(ls, QUI).split("\r\n");
    expect(cab).toBe(COLUNAS_CARGA_PARADA.join(";"));
    expect(rest.map((r) => r.split(";")[0])).toEqual(["JUIZ DE FORA", "JUIZ DE FORA", "SEM BASE", "VARGINHA", "VARGINHA", "VARGINHA"]);
    // AJF: informação faltante (2) antes de devolução/reversa (99)
    expect(rest[0]).toContain(";Informação faltante - resolver rápido;");
    expect(rest[1]).toContain(";REVERSA;");
    expect(rest[1]).toContain(";Devolução/reversa;");
    // VGA: pré-entrega da mais recente para a mais antiga, depois o 40
    expect(rest[3]).toContain(";Pré-entrega;36 - CHEGADA NA BASE;");
    expect(rest[4]).toContain('"36 - AGUARDA; CLIENTE"');
    expect(rest[5]).toContain(";Redespacho final;");
    expect(rest[3]!.startsWith("VARGINHA;Bruno;VGA;")).toBe(true);
    expect(rest[3]!.endsWith(";2;2;7")).toBe(true);
    expect(campoCsv('a"b')).toBe('"a""b"');
  });
});

describe("pré-entrega: obrigatórias × podem esperar", () => {
  it("na sexta, previsão de segunda é obrigatória (o dia seguinte corrido do Pendências diria 'pode esperar')", () => {
    const p = resumirPreEntrega(
      [
        linha({ previsao_entrega: "2026-10-19", qtd_volumes: 3 }), // segunda: obrigatória
        linha({ previsao_entrega: "2026-10-17" }), // sábado: obrigatória
        linha({ previsao_entrega: "2026-10-15" }), // ontem: obrigatória e atrasada
        linha({ previsao_entrega: "2026-10-16" }), // hoje: obrigatória, não atrasada
        linha({ previsao_entrega: "2026-10-20" }), // terça: pode esperar
        linha({ previsao_entrega: null }), // sem previsão
        linha({ tipo_cte: "DEVOLUCAO", previsao_entrega: "2026-10-15" }), // fora
        linha({ tipo_cte: "REVERSA" }), // fora
        linha({ cod_ultima_ocorrencia: 41 }), // não é pré-entrega
      ],
      SEX,
    );
    expect(p.proximoDiaUtil).toBe("2026-10-19");
    expect(p.total).toBe(6);
    expect(p.obrigatorias).toEqual({ notas: 4, volumes: 9 });
    expect(p.atrasadas).toEqual({ notas: 1, volumes: 2 });
    expect(p.podemEsperar).toEqual({ notas: 1, volumes: 2 });
    expect(p.semPrevisao).toEqual({ notas: 1, volumes: 2 });
  });

  it("véspera de feriado: o corte pula o feriado (sexta 09/10 → terça 13/10)", () => {
    const p = resumirPreEntrega([linha({ previsao_entrega: "2026-10-13" }), linha({ previsao_entrega: "2026-10-14" })], meioDia("2026-10-09"));
    expect(p.proximoDiaUtil).toBe("2026-10-13");
    expect(p.obrigatorias.notas).toBe(1);
    expect(p.podemEsperar.notas).toBe(1);
  });

  it("por base, mais obrigatórias primeiro; a nota mais urgente da base vem antes", () => {
    const a = linha({ unidade: "AJF", previsao_entrega: "2026-10-09" });
    const b = linha({ unidade: "AJF", previsao_entrega: "2026-10-05" });
    const c = linha({ unidade: "VGA", previsao_entrega: "2026-10-30" });
    const p = resumirPreEntrega([c, a, b], QUI);
    expect(p.porBase.map((x) => x.base)).toEqual(["JUIZ DE FORA", "VARGINHA"]);
    expect(p.porBase[0]).toMatchObject({ obrigatorias: { notas: 2, volumes: 4 }, atrasadas: { notas: 1, volumes: 2 }, itens: [b.op_item_id, a.op_item_id] });
    expect(p.porBase[1]).toMatchObject({ obrigatorias: { notas: 0, volumes: 0 }, podemEsperar: { notas: 1, volumes: 2 } });
  });
});
