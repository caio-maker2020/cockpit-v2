import { describe, expect, it } from "vitest";
import { criarAdaptadorDemo, lerFixtureFila } from "./adaptadorDemo";

describe("fixture real opcional do modo demonstração", () => {
  it("aceita só array de linhas com CTRC e completa o que falta", () => {
    expect(lerFixtureFila({ nao: "array" })).toEqual([]);
    const linhas = lerFixtureFila([
      { ctrc: " vga1-2 ", nf: 123, cod_ultima_ocorrencia: 36, descricao_oc: "Chegada na base", unidade: "VGA" },
      { nf: "sem ctrc" },
      { ctrc: "X9", status: "encerrado" },
    ]);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ op_item_id: "real-1", ctrc: "VGA1-2", nf: "123", status: "aberto", sugestao: null });
  });

  it("com linhas reais, a demo usa ELAS (não os fictícios) e mantém as cercas", async () => {
    const api = criarAdaptadorDemo({
      latenciaMs: 0,
      simularWorker: false,
      linhasReais: lerFixtureFila([
        {
          op_item_id: "r1",
          ctrc: "POA123-4",
          nf: "555",
          unidade: "POA",
          cod_ultima_ocorrencia: 36,
          descricao_oc: "Chegada na base para entrega",
          sugestao: { codigo: 15, texto: "Base sem janela", confianca: 0.8, casos: { n: 8, m: 10 } },
        },
      ]),
    });
    expect(api.origemDados).toBe("fixture");
    const fila = await api.fila();
    expect(fila.map((l) => l.op_item_id)).toEqual(["r1"]);
    expect(fila[0]!.descricao_oc).toBe("Chegada na base para entrega");
    expect(fila[0]!.sugestao?.lancavel).toBe(true);
    const sessao = await api.minhaSessao();
    expect(sessao?.membro?.unidades).toEqual(["POA"]);
    const p = await api.previa("r1", 15, "Base sem janela");
    expect(p.ok).toBe(true);
    expect((await api.previa("r1", 56, "")).ok).toBe(false);
  });

  it("aceita sugestão v2 de encaminhar (codigo null) e o aceitar recusa: cada ação tem seu botão", async () => {
    const linhas = lerFixtureFila([
      {
        op_item_id: "r2",
        ctrc: "BHZ1-1",
        nf: "9",
        unidade: "BHZ",
        cod_ultima_ocorrencia: 13,
        sugestao: { versao_contrato: 2, acao: "encaminhar_relacionamento", fonte: "agente_ia", codigo: null, texto: "Falar com o cliente", confianca: 0.8 },
      },
    ]);
    expect(linhas[0]!.sugestao?.acao).toBe("encaminhar_relacionamento");
    const api = criarAdaptadorDemo({ latenciaMs: 0, simularWorker: false, linhasReais: linhas });
    expect(await api.aceitarSugestao("r2", "x")).toMatchObject({ ok: false, erro: "sugestao_e_encaminhamento" });
    const p = await api.previaEncaminhamento("r2", "");
    expect(p.ok).toBe(true);
    const ok = p as Extract<typeof p, { ok: true }>;
    expect(await api.encaminhar("r2", "", "token-errado")).toMatchObject({ ok: false, erro: "previa_desatualizada" });
    expect(await api.encaminhar("r2", "", ok.confirmacao)).toMatchObject({ ok: true, status: "enviado" });
    expect(await api.fila()).toEqual([]);
  });
});
