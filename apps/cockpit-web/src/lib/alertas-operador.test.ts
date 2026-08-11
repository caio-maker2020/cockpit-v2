import { describe, expect, it } from "vitest";
import {
  type AlertaOperadorRow,
  montarConversa,
  pendentes,
  quandoRelativo,
  TEXTO_BARRA,
  textoBarra,
} from "./alertas-operador";

const AGORA = new Date("2026-08-11T18:00:00Z").getTime();

function alerta(over: Partial<AlertaOperadorRow> = {}): AlertaOperadorRow {
  return {
    id: "a1",
    card_id: "card-1",
    nf: "306856",
    tipo: "resposta_cliente_sem_acionamento",
    titulo: "Card possivelmente travado — NF 306856",
    relatorio: {
      sintoma: "O cliente respondeu na NF 306856 há 1 dia, mas o card não foi para CLIENTE RESPONDEU.",
      o_que_aconteceu: ["A resposta CHEGOU e está anexada no card.", "O card ficou parado."],
      qual_card: "NF 306856 — card em AGUARDANDO_CLIENTE.",
      causa_provavel: "Quando a resposta chegou, o card estava num estado que não aciona.",
      o_que_verificar: ["Abra a NF 306856.", "Confirme se exige ação sua."],
      impacto: "O cliente está esperando resposta.",
      pedido: "Confere e me manda pro corretor oficial de bugs, ou clica em LIDO.",
    },
    criado_em: "2026-08-11T17:30:00Z",
    lido_em: null,
    encaminhado_em: null,
    ...over,
  };
}

describe("barra inferior", () => {
  it("usa o texto exato definido pelo Caio quando é 1 card", () => {
    expect(textoBarra(1)).toBe(TEXTO_BARRA);
    expect(textoBarra(0)).toBe(TEXTO_BARRA);
    expect(TEXTO_BARRA).toContain("O agente está te chamando");
  });

  it("pluraliza quando há mais de um card travado", () => {
    expect(textoBarra(3)).toContain("3 cards travados");
  });
});

describe("conversa do agente", () => {
  it("monta as falas na ordem: o que houve → qual card → por quê → o que fazer → pedido", () => {
    const falas = montarConversa(alerta());
    expect(falas.length).toBeGreaterThanOrEqual(6);
    expect(falas[0].texto).toContain("cliente respondeu");
    const idxCard = falas.findIndex((f) => f.enfase);
    const idxCausa = falas.findIndex((f) => f.texto.includes("estado que não aciona"));
    const idxPedido = falas.findIndex((f) => f.texto.includes("LIDO"));
    expect(idxCard).toBeGreaterThan(0);
    expect(idxCausa).toBeGreaterThan(idxCard);
    expect(idxPedido).toBe(falas.length - 1);
  });

  it("destaca a fala do card (é o dado que o operador precisa ver)", () => {
    const falas = montarConversa(alerta());
    const enfase = falas.find((f) => f.enfase)!;
    expect(enfase.texto).toContain("306856");
  });

  it("agrupa o passo a passo numa fala só, com marcadores", () => {
    const falas = montarConversa(alerta());
    const passos = falas.find((f) => f.texto.startsWith("O que eu preciso"))!;
    expect(passos.texto).toContain("• Abra a NF 306856.");
    expect(passos.texto).toContain("• Confirme se exige ação sua.");
  });

  it("alerta sem relatório estruturado não vira conversa vazia", () => {
    const falas = montarConversa(alerta({ relatorio: null }));
    expect(falas).toHaveLength(1);
    expect(falas[0].texto).toContain("306856");
  });

  it("ignora campos vazios sem criar bolha em branco", () => {
    const falas = montarConversa(alerta({ relatorio: { sintoma: "só isso", o_que_verificar: [] } }));
    expect(falas).toHaveLength(1);
  });
});

describe("LIDO faz sumir", () => {
  it("alerta lido sai da lista", () => {
    const lista = [alerta(), alerta({ id: "a2", lido_em: "2026-08-11T17:45:00Z" })];
    expect(pendentes(lista).map((a) => a.id)).toEqual(["a1"]);
  });

  it("encaminhado mas não lido continua aparecendo até marcar LIDO", () => {
    const lista = [alerta({ encaminhado_em: "2026-08-11T17:50:00Z" })];
    expect(pendentes(lista)).toHaveLength(1);
  });
});

describe("carimbo de tempo", () => {
  it("fala em minutos, horas e dias como mensageiro", () => {
    expect(quandoRelativo("2026-08-11T17:59:40Z", AGORA)).toBe("agora");
    expect(quandoRelativo("2026-08-11T17:30:00Z", AGORA)).toBe("há 30 min");
    expect(quandoRelativo("2026-08-11T15:00:00Z", AGORA)).toBe("há 3h");
    expect(quandoRelativo("2026-08-10T15:00:00Z", AGORA)).toBe("ontem");
    expect(quandoRelativo("2026-08-05T15:00:00Z", AGORA)).toBe("há 6 dias");
  });
});
