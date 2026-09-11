// INV-153 (Karol 2026-09-11, NF 436268) — a aprovação recusada pela parede
// deixa rastro. Antes: 903 eventos Oc33BloqueadaDossieIncompleto, TODOS do robô
// montando proposta, ZERO de operadora clicando.
// Rodar: npx vitest run src/lib/aprovacaoRecusadaEvento.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  codigoDaRecusa,
  montarEventoAprovacaoRecusada,
  MSG_APROVACAO_CANCELADA,
} from "./aprovacaoRecusadaEvento";

const base = {
  cardId: "03cc06eb-1a61-4778-8a80-b113df4645c4", // NF 436268
  todoId: "5d3432d0-3e8f-438d-a88b-a0fa9e782952",
  operadorId: "460a10bc-5978-4c26-9588-30d7a6039dac", // KAROLINE
};

describe("codigoDaRecusa", () => {
  it("extrai o código da parede da oc 33", () => {
    expect(
      codigoDaRecusa(
        'OC33_DOSSIE_INCOMPLETO: a oc 33 deste card so pode ser lancada COMPLETA — faltando: ["descrição dos itens"].',
      ),
    ).toBe("OC33_DOSSIE_INCOMPLETO");
  });

  it("extrai as outras recusas conhecidas da mesma RPC", () => {
    expect(codigoDaRecusa("FEEDBACK_OC49_OBRIGATORIO: o agente nao reconheceu")).toBe(
      "FEEDBACK_OC49_OBRIGATORIO",
    );
  });

  it("erro sem prefixo vira OUTRO — agrupar por mensagem inteira não é métrica", () => {
    expect(codigoDaRecusa("Todo x já em status=aprovado")).toBe("OUTRO");
    expect(codigoDaRecusa(null)).toBe("OUTRO");
    expect(codigoDaRecusa("")).toBe("OUTRO");
  });
});

describe("montarEventoAprovacaoRecusada — o caso da Karol", () => {
  it("grava motivo, carimbo e QUANTOS anexos ela tinha marcado", () => {
    const ev = montarEventoAprovacaoRecusada({
      ...base,
      mensagemErro:
        'OC33_DOSSIE_INCOMPLETO: a oc 33 deste card so pode ser lancada COMPLETA — faltando: ["descrição dos itens"].',
      propostaPayload: {
        tool: "lancar_oc33_solo_portal",
        args: { codigo_ssw: 33 },
        meta: { gate_oc33: { bloqueada: true, faltando: ["descrição dos itens"] } },
      },
      // os 4 anexos do print: 1 PDF convertido + 3 imagens de WhatsApp
      extrasEnviados: { anexos_ids: ["a", "b", "c", "d"] },
    });
    expect(ev).not.toBeNull();
    expect(ev!.event_type).toBe("AprovacaoRecusadaNaParede");
    expect(ev!.payload["motivo_codigo"]).toBe("OC33_DOSSIE_INCOMPLETO");
    expect(ev!.payload["tool"]).toBe("lancar_oc33_solo_portal");
    expect(ev!.payload["anexos_selecionados"]).toBe(4);
    expect(ev!.payload["gate_oc33"]).toEqual({
      bloqueada: true,
      faltando: ["descrição dos itens"],
    });
  });

  it("o formato passa na RLS card_events_insert_operator", () => {
    // actor_type='operator' E actor_id = id do operador. A telemetria do
    // conversor de PDF ficou CEGA de 08/09 por mandar uma string fixa aqui.
    const ev = montarEventoAprovacaoRecusada({ ...base, mensagemErro: "X_Y_Z: falhou" });
    expect(ev!.actor_type).toBe("operator");
    expect(ev!.actor_id).toBe(base.operadorId);
    expect(ev!.card_id).toBe(base.cardId);
  });
});

describe("montarEventoAprovacaoRecusada — o que NÃO se registra", () => {
  it("sem operador NÃO monta evento (a RLS recusaria em silêncio)", () => {
    expect(
      montarEventoAprovacaoRecusada({ ...base, operadorId: null, mensagemErro: "X_Y: a" }),
    ).toBeNull();
    expect(
      montarEventoAprovacaoRecusada({ ...base, operadorId: undefined, mensagemErro: "X_Y: a" }),
    ).toBeNull();
  });

  it("desistência da própria operadora não é recusa da parede", () => {
    expect(
      montarEventoAprovacaoRecusada({ ...base, mensagemErro: MSG_APROVACAO_CANCELADA }),
    ).toBeNull();
  });

  it("sem card ou sem todo não monta", () => {
    expect(montarEventoAprovacaoRecusada({ ...base, cardId: null, mensagemErro: "A_B: x" })).toBeNull();
    expect(montarEventoAprovacaoRecusada({ ...base, todoId: null, mensagemErro: "A_B: x" })).toBeNull();
  });

  it("sem anexos marcados conta zero, nunca undefined", () => {
    const ev = montarEventoAprovacaoRecusada({ ...base, mensagemErro: "A_B: x" });
    expect(ev!.payload["anexos_selecionados"]).toBe(0);
  });
});

describe("INV-153: fiação em ProposedActions.tsx", () => {
  const src = readFileSync(
    resolve(__dirname, "../components/cards/ProposedActions.tsx"),
    "utf-8",
  );

  it("o onError registra a recusa", () => {
    expect(src).toContain("montarEventoAprovacaoRecusada({");
    expect(src).toContain('.from("card_events")');
    // precisa do id do operador (a RLS exige) — `user` sozinho não serve
    expect(src).toContain("const { user, operador } = useAuth();");
    expect(src).toContain("operadorId: operador?.id");
  });

  it("a constante de cancelamento tem FONTE ÚNICA", () => {
    // Era um const solto dentro do componente. Duas verdades divergindo fariam
    // o lado errado gravar "desisti" como se fosse recusa do banco.
    expect(src).not.toContain('const MSG_APROVACAO_CANCELADA = "');
    expect(src).toContain("MSG_APROVACAO_CANCELADA,");
  });
});
