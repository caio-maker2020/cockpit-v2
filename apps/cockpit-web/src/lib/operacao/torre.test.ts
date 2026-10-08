import { describe, expect, it } from "vitest";
import { avisosDoConselheiro, casaFoco, decisaoDaNota, registroDoTurno, resumirTorre } from "./torre";
import type { OpFilaLinha } from "./tipos";

const AGORA = Date.parse("2026-10-08T15:00:00Z");
const dias = (d: number) => new Date(AGORA - d * 86_400_000).toISOString();

let seq = 0;
function linha(p: Partial<OpFilaLinha> = {}): OpFilaLinha {
  seq++;
  return {
    op_item_id: `i${seq}`, ctrc: `C${seq}`, nf: `${seq}`, unidade: "VGA", status: "aberto",
    cod_ultima_ocorrencia: 41, descricao_oc: "INFORMACAO COMPLEMENTAR", data_ultima_ocorrencia: dias(1),
    instrucao_ultima_ocorrencia: null, pagador: null, destinatario: null, cidade_destino: "VARGINHA", uf_destino: "MG",
    previsao_entrega: null, atraso_original: null, qtd_volumes: null, assumido_por: null, assumido_por_nome: null,
    assumido_em: null, sugestao: null, sugestao_em: null, lancamento_id: null, lancamento_status: null,
    lancamento_codigo_oc: null, lancamento_solicitado_por_nome: null, lancamento_solicitado_em: null,
    materializado_em: dias(0), updated_at: dias(0), ...p,
  };
}

const firmeAguardar = { codigo: null, acao: "aguardar" as const, fonte: "regra_aprendida" as const, confianca: 0.98 };
const firmeLancar = { codigo: 36, fonte: "regra_aprendida" as const, confianca: 0.95, lancavel: true };
const duvida = { codigo: null, acao: "encaminhar_relacionamento" as const, fonte: "regra_aprendida" as const, confianca: 0.667 };

describe("decisão da torre por nota", () => {
  it("firme × dúvida × sem sugestão × em andamento", () => {
    expect(decisaoDaNota(linha({ sugestao: firmeAguardar }))).toBe("firme_aguardar");
    expect(decisaoDaNota(linha({ sugestao: firmeLancar }))).toBe("firme_acao");
    expect(decisaoDaNota(linha({ sugestao: duvida }))).toBe("duvida");
    expect(decisaoDaNota(linha())).toBe("sem_sugestao");
    expect(decisaoDaNota(linha({ sugestao: firmeLancar, lancamento_status: "fila" }))).toBe("em_andamento");
  });
  it("foco recorta por família, decisão e lista de notas", () => {
    const a = linha({ sugestao: duvida });
    const b = linha({ cod_ultima_ocorrencia: 12, sugestao: firmeAguardar });
    expect(casaFoco(a, { tipo: "decisao", id: "duvida" })).toBe(true);
    expect(casaFoco(b, { tipo: "decisao", id: "firme" })).toBe(true);
    expect(casaFoco(b, { tipo: "familia", id: "comprovante" })).toBe(true);
    expect(casaFoco(a, { tipo: "itens", ids: [b.op_item_id], rotulo: "x" })).toBe(false);
    expect(casaFoco(a, null)).toBe(true);
  });
});

describe("resumo da torre", () => {
  it("conta firmes, dúvidas e certeza; firme de lançar com código fora da lista volta para o operador", () => {
    const r = resumirTorre(
      [linha({ sugestao: firmeAguardar }), linha({ sugestao: firmeLancar }), linha({ sugestao: { ...firmeLancar, codigo: 99 } }), linha({ sugestao: duvida }), linha()],
      AGORA,
      new Set([36]),
    );
    expect(r.total).toBe(5);
    expect(r.firmesAguardar).toBe(1);
    expect(r.firmesAcao).toBe(1);
    expect(r.duvidas).toBe(2);
    expect(r.semSugestao).toBe(1);
    expect(r.certeza).toEqual({ alta: 3, media: 1, baixa: 0 });
    const info = r.especialistas.find((e) => e.id === "informacao")!;
    expect(info.status).toBe("precisa_voce");
    expect(info.frase).toMatch(/precisam de você/);
  });
});

describe("conselheiro", () => {
  it("avisa 3+ notas iguais (mesma oc, mesma cidade) paradas há dias", () => {
    const g = [linha({ data_ultima_ocorrencia: dias(7) }), linha({ data_ultima_ocorrencia: dias(8) }), linha({ data_ultima_ocorrencia: dias(9) })];
    const avisos = avisosDoConselheiro(g, AGORA);
    expect(avisos[0]!.titulo).toBe("3 notas iguais paradas há 7 dias ou mais");
    expect(avisos[0]!.detalhe).toMatch(/Varginha\/MG/);
    expect(avisos[0]!.itens).toHaveLength(3);
  });
  it("lançamento com erro vem primeiro", () => {
    const avisos = avisosDoConselheiro([linha({ lancamento_status: "erro" })], AGORA);
    expect(avisos[0]!.tom).toBe("critico");
  });
});

describe("registro do turno", () => {
  it("em linguagem simples, mais recente primeiro", () => {
    const ls = [
      linha({ assumido_em: dias(0.2), assumido_por_nome: "Marina" }),
      linha({ lancamento_solicitado_em: dias(0.1), lancamento_codigo_oc: 14, lancamento_status: "fila", lancamento_solicitado_por_nome: "Marina" }),
    ];
    const ev = registroDoTurno(ls, resumirTorre(ls, AGORA, null));
    expect(ev[0]!.texto).toMatch(/^leu 2 notas da fila/);
    expect(ev[1]!.texto).toBe(`confirmou a ocorrência 14 na NF ${ls[1]!.nf}, e o pedido está na fila do SSW.`);
    expect(ev[2]!.texto).toBe(`assumiu a NF ${ls[0]!.nf}.`);
  });
});
