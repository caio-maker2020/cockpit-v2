// deno test --allow-env supabase/functions/_shared/oc11-pos-resposta.test.ts
//
// Etapa 2 da "Padronização Ocorrência 11" (Isadora 07/08; escopo Caio 08/08):
// resposta ÚTIL do cliente (endereço/contato/dado do destino) → 21 + cancela
// reentrega + texto no SSW; resposta VAZIA → fica no 54 + pendências (sugestão
// = responder o e-mail cobrando) e NADA é patchado.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aplicarPacoteOc11PosResposta,
  decidirPacoteOc11PosResposta,
  ehFluxoEnderecoOc11,
  montarTextoSswCorrecaoRecebida,
  MOTIVO_CANCELAMENTO_CORRECAO,
  TEXTO_SSW_CORRECAO_RECEBIDA,
} from "./oc11-pos-resposta.ts";

const SSW_F6_MAXLEN = 70;

const ANALISE_OC11 = { codigo_oc_card: 11, proposta_destacada: 54 };
const ANALISE_OC49 = { codigo_oc_card: 49 };

// ---------------------------------------------------------------------------
// Decisão pura
// ---------------------------------------------------------------------------

Deno.test("fluxo-endereço: só análise da época com codigo_oc_card=11", () => {
  assertEquals(ehFluxoEnderecoOc11(ANALISE_OC11), true);
  assertEquals(ehFluxoEnderecoOc11(ANALISE_OC49), false);
  assertEquals(ehFluxoEnderecoOc11(null), false);
  assertEquals(ehFluxoEnderecoOc11({}), false);
});

Deno.test("resposta ÚTIL (21 final) no fluxo oc11 → pacote com texto + motivo", () => {
  const p = decidirPacoteOc11PosResposta(ANALISE_OC11, {
    oc_sugerida: 21,
    instrucao_reentrega_sugerida: "Entregar na Rua das Acácias, 123 — falar com João",
  });
  assert(p !== null);
  assert(p!.texto_ssw.startsWith(TEXTO_SSW_CORRECAO_RECEBIDA), "frase-âncora primeiro");
  assert(p!.texto_ssw.includes("RUA DAS ACACIAS, 123"), "correção registrada, sem acento");
  assertEquals(p!.motivo_cancelamento, MOTIVO_CANCELAMENTO_CORRECAO);
});

Deno.test("resposta VAZIA (54 + pendências) → SEM pacote — sugestão é responder o e-mail", () => {
  const p = decidirPacoteOc11PosResposta(ANALISE_OC11, {
    oc_sugerida: 54,
    pendencias_resposta_cliente: ["Faltou o endereço/contato corrigido pra liberar a reentrega"],
  });
  assertEquals(p, null);
});

Deno.test("21 rebaixado pra 54 pelo INV-017 → sem pacote (a coerência manda)", () => {
  const p = decidirPacoteOc11PosResposta(ANALISE_OC11, {
    oc_sugerida: 54,
    rebaixado_de_oc21_por_pendencia: true,
  });
  assertEquals(p, null);
});

Deno.test("21 FORA do fluxo oc11 (ex: recusa comum) → sem pacote — não cancela reentrega alheia", () => {
  assertEquals(decidirPacoteOc11PosResposta(ANALISE_OC49, { oc_sugerida: 21 }), null);
  assertEquals(decidirPacoteOc11PosResposta(null, { oc_sugerida: 21 }), null);
});

Deno.test("texto do SSW: ASCII puro, frase sobrevive aos 70 chars, cabe em 500", () => {
  const longa = "Endereço novo: Avenida São João, 4.500 — condomínio Jardim das Oliveiras, " +
    "portaria 2, procurar Sr. José Antônio às 14h. ".repeat(6);
  const texto = montarTextoSswCorrecaoRecebida(longa);
  assert(/^[\x20-\x7E]+$/.test(texto), `não-ASCII: ${texto.slice(0, 90)}`);
  assert(texto.length <= 500, "cabe no observ");
  assert(texto.slice(0, SSW_F6_MAXLEN).includes(TEXTO_SSW_CORRECAO_RECEBIDA.slice(0, 40)));
  assertEquals(montarTextoSswCorrecaoRecebida(null), TEXTO_SSW_CORRECAO_RECEBIDA);
});

// ---------------------------------------------------------------------------
// Patch no todo (mock supabase)
// ---------------------------------------------------------------------------

function makeMock(opts: {
  card?: Record<string, unknown> | null;
  todos?: Array<Record<string, unknown>>;
}) {
  const updates: Array<{ id: unknown; proposta_payload: Record<string, unknown> }> = [];
  const eventos: Array<Record<string, unknown>> = [];

  function builder(table: string) {
    const state: { update?: unknown; insert?: unknown; eqArgs: Array<[string, unknown]> } = { eqArgs: [] };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c?: string, v?: unknown) => {
        if (typeof c === "string") state.eqArgs.push([c, v]);
        return b;
      },
      update: (obj: unknown) => {
        state.update = obj;
        return b;
      },
      insert: (obj: unknown) => {
        state.insert = obj;
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: table === "cards" ? (opts.card ?? null) : null, error: null }),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        let result: unknown;
        if (state.update && table === "todos") {
          const idEq = state.eqArgs.find(([c]) => c === "id");
          updates.push({
            id: idEq?.[1],
            proposta_payload: (state.update as Record<string, unknown>)["proposta_payload"] as Record<string, unknown>,
          });
          result = { data: null, error: null };
        } else if (state.insert && table === "card_events") {
          eventos.push(state.insert as Record<string, unknown>);
          result = { data: null, error: null };
        } else {
          result = { data: table === "todos" ? (opts.todos ?? []) : [], error: null };
        }
        return Promise.resolve(result).then(onF, onR);
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  return { supabase: { from: (t: string) => builder(t) } as any, updates, eventos };
}

const todo21Pendente = (extras?: Record<string, unknown>) => ({
  id: "todo-21",
  status: "pendente",
  proposta_payload: {
    tool: "lancar_ocorrencia",
    acao_key: "lancar_ocorrencia:21",
    args: { codigo_ssw: 21, nf: "123", ...(extras ? { extras } : {}) },
    meta: { origem: "vinculador_pos_resposta_cliente" },
  },
});

const CARD_21_UTIL = {
  analise_padrao_resultado: ANALISE_OC11,
  ia_sugestao_oc_resposta: {
    oc_sugerida: 21,
    instrucao_reentrega_sugerida: "Rua Nova, 45 — tel (31) 99999-0000",
  },
};

Deno.test("PATCH: todo de 21 pendente ganha o pacote + card_event", async () => {
  const { supabase, updates, eventos } = makeMock({
    card: CARD_21_UTIL,
    todos: [todo21Pendente(), { id: "t54", status: "pendente", proposta_payload: { tool: "lancar_ocorrencia", args: { codigo_ssw: 54 } } }],
  });
  const ok = await aplicarPacoteOc11PosResposta(supabase, "card-1", "teste");
  assertEquals(ok, true);
  assertEquals(updates.length, 1);
  assertEquals(updates[0].id, "todo-21");
  const extras = ((updates[0].proposta_payload["args"] as Record<string, unknown>)["extras"] ?? {}) as Record<string, unknown>;
  assertEquals(extras["cancelar_reentrega_24h"], true);
  assertEquals(extras["motivo_cancelamento"], MOTIVO_CANCELAMENTO_CORRECAO);
  assert(String(extras["texto_descricao"]).includes("RUA NOVA, 45"));
  assertEquals(eventos.length, 1);
  assertEquals(eventos[0]["event_type"], "Oc11PosRespostaPacoteAplicado");
});

Deno.test("PATCH idempotente: já com o pacote → no-op", async () => {
  const jaPatchado = todo21Pendente({
    texto_descricao: montarTextoSswCorrecaoRecebida("Rua Nova, 45 — tel (31) 99999-0000"),
    cancelar_reentrega_24h: true,
  });
  const { supabase, updates, eventos } = makeMock({ card: CARD_21_UTIL, todos: [jaPatchado] });
  const ok = await aplicarPacoteOc11PosResposta(supabase, "card-1", "teste");
  assertEquals(ok, false);
  assertEquals(updates.length, 0);
  assertEquals(eventos.length, 0);
});

Deno.test("SEM pacote (decisão 54) → nada tocado mesmo com todo de 21 na mesa", async () => {
  const { supabase, updates } = makeMock({
    card: {
      analise_padrao_resultado: ANALISE_OC11,
      ia_sugestao_oc_resposta: { oc_sugerida: 54, pendencias_resposta_cliente: ["faltou endereço"] },
    },
    todos: [todo21Pendente()],
  });
  const ok = await aplicarPacoteOc11PosResposta(supabase, "card-1", "teste");
  assertEquals(ok, false);
  assertEquals(updates.length, 0);
});

Deno.test("card fora do fluxo oc11 → nada tocado (não cancela reentrega alheia)", async () => {
  const { supabase, updates } = makeMock({
    card: { analise_padrao_resultado: ANALISE_OC49, ia_sugestao_oc_resposta: { oc_sugerida: 21 } },
    todos: [todo21Pendente()],
  });
  assertEquals(await aplicarPacoteOc11PosResposta(supabase, "card-1", "teste"), false);
  assertEquals(updates.length, 0);
});

Deno.test("sem todo de 21 ativo → false (nunca cria todo)", async () => {
  const { supabase, updates } = makeMock({
    card: CARD_21_UTIL,
    todos: [{ id: "t21c", status: "cancelado", proposta_payload: { tool: "lancar_ocorrencia", args: { codigo_ssw: 21 } } }],
  });
  assertEquals(await aplicarPacoteOc11PosResposta(supabase, "card-1", "teste"), false);
  assertEquals(updates.length, 0);
});
