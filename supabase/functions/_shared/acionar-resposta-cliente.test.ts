// Testes da FONTE ÚNICA do efeito do acionamento (INV-067 / INV-042).
//
// O que estes testes travam: a semântica que estava inline no vinculador e que
// o reconciliador passou a compartilhar. Se alguém reimplementar o efeito fora
// deste helper — ou mudar o UPDATE — estes testes quebram.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { acionarRespostaCliente } from "./acionar-resposta-cliente.ts";

type Captura = {
  updates: Array<Record<string, unknown>>;
  eventos: Array<Record<string, unknown>>;
  rpcs: Array<{ nome: string; args: unknown }>;
};

/** Fake mínimo do supabase-js cobrindo só o que o helper usa. */
function fakeSupabase(cap: Captura) {
  return {
    from(tabela: string) {
      return {
        update(payload: Record<string, unknown>) {
          cap.updates.push({ tabela, ...payload });
          return { eq: () => Promise.resolve({ data: null, error: null }) };
        },
        insert(payload: Record<string, unknown>) {
          cap.eventos.push({ tabela, ...payload });
          return Promise.resolve({ data: null, error: null });
        },
        select() {
          // `.single()` devolve card nulo de propósito: assim
          // atualizarPropostasAposRespostaCliente retorna cedo e o teste isola
          // a semântica do acionamento (que é o que este arquivo trava).
          return {
            eq: () => ({
              order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
              maybeSingle: () => Promise.resolve({ data: null }),
              single: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        },
      };
    },
    rpc(nome: string, args: unknown) {
      cap.rpcs.push({ nome, args });
      return Promise.resolve({ data: 0, error: null });
    },
  };
}

function setup() {
  const cap: Captura = { updates: [], eventos: [], rpcs: [] };
  Deno.env.set("SUPABASE_URL", "http://localhost:0");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake");
  // interpretador indisponível de propósito: acionamento NÃO pode depender da IA
  return cap;
}

Deno.test("card em AGUARDANDO_CLIENTE: carimba, MOVE pra AVH e trava o lock", async () => {
  const cap = setup();
  // deno-lint-ignore no-explicit-any
  await acionarRespostaCliente(fakeSupabase(cap) as any, {
    cardId: "card-1",
    messageId: "msg-1",
    stateAnterior: "AGUARDANDO_CLIENTE",
    actorId: "reconciliador-resposta-pendente",
  });
  const upd = cap.updates.find((u) => u.tabela === "cards")!;
  assertEquals(upd.state, "AGUARDANDO_VALIDACAO_HUMANA");
  assertEquals(upd.lock_aguardando_validacao, true);
  assertEquals(upd.acao_executada_em, null);
  assertEquals(upd.ia_sugestao_oc_resposta, null);
  assertEquals(typeof upd.cliente_respondeu_em, "string");
});

Deno.test("card em ACAO_EXECUTADA também move (janela pós-lançamento)", async () => {
  const cap = setup();
  // deno-lint-ignore no-explicit-any
  await acionarRespostaCliente(fakeSupabase(cap) as any, {
    cardId: "card-2",
    stateAnterior: "ACAO_EXECUTADA",
    actorId: "vinculador",
  });
  const upd = cap.updates.find((u) => u.tabela === "cards")!;
  assertEquals(upd.state, "AGUARDANDO_VALIDACAO_HUMANA");
  assertEquals(upd.lock_aguardando_validacao, true);
});

Deno.test("card JÁ em AVH: carimba e zera IA, mas NÃO mexe no state (Caio 2026-05-19)", async () => {
  const cap = setup();
  // deno-lint-ignore no-explicit-any
  await acionarRespostaCliente(fakeSupabase(cap) as any, {
    cardId: "card-3",
    stateAnterior: "AGUARDANDO_VALIDACAO_HUMANA",
    actorId: "reconciliador-resposta-pendente",
  });
  const upd = cap.updates.find((u) => u.tabela === "cards")!;
  assertEquals(upd.state, undefined);
  assertEquals(upd.lock_aguardando_validacao, undefined);
  assertEquals(upd.ia_sugestao_oc_resposta, null);
  assertEquals(typeof upd.cliente_respondeu_em, "string");
});

Deno.test("falha do interpretador NÃO derruba o acionamento (card fica visível)", async () => {
  const cap = setup();
  // URL inválida força o fetch a estourar; o helper tem que seguir
  // deno-lint-ignore no-explicit-any
  const r = await acionarRespostaCliente(fakeSupabase(cap) as any, {
    cardId: "card-4",
    stateAnterior: "AGUARDANDO_CLIENTE",
    actorId: "vinculador",
  });
  assertEquals(r.interpretadorOk, false);
  assertEquals(cap.updates.length, 1); // carimbo aconteceu mesmo assim
  assertEquals(cap.eventos.length, 1); // e o evento foi gravado
});

Deno.test("sempre cancela ações agendadas e grava RetornoClienteEmAguardo", async () => {
  const cap = setup();
  // deno-lint-ignore no-explicit-any
  await acionarRespostaCliente(fakeSupabase(cap) as any, {
    cardId: "card-5",
    messageId: "msg-5",
    stateAnterior: "AGUARDANDO_CLIENTE",
    actorId: "reconciliador-resposta-pendente",
    motivoCancelamentoAgendadas: "cliente respondeu (reconciliador INV-067)",
    payloadExtra: { via: "reconciliador" },
  });
  assertEquals(cap.rpcs[0].nome, "cancelar_acoes_agendadas_do_card");
  const ev = cap.eventos.find((e) => e.tabela === "card_events")!;
  assertEquals(ev.event_type, "RetornoClienteEmAguardo");
  assertEquals(ev.actor_id, "reconciliador-resposta-pendente");
  const payload = ev.payload as Record<string, unknown>;
  assertEquals(payload.new_state, "AGUARDANDO_VALIDACAO_HUMANA");
  assertEquals(payload.via, "reconciliador");
  assertEquals(payload.message_id, "msg-5");
});

Deno.test("o marcador do evento é o MESMO dos dois callers (senão o INV-067 cega)", async () => {
  // O detector exclui cards que já têm RetornoClienteEmAguardo. Se um caller
  // gravar outro event_type, o card volta a ser reconciliado em loop.
  for (const actor of ["vinculador", "reconciliador-resposta-pendente"]) {
    const cap = setup();
    // deno-lint-ignore no-explicit-any
    await acionarRespostaCliente(fakeSupabase(cap) as any, {
      cardId: "card-6",
      stateAnterior: "AGUARDANDO_CLIENTE",
      actorId: actor,
    });
    assertEquals(cap.eventos[0].event_type, "RetornoClienteEmAguardo");
  }
});

// ── Políticas explícitas (INV-067, 2026-08-11) ────────────────────────────────
// Existem porque os 2 callers que faltavam tinham regra PRÓPRIA. Em vez de
// mudar o comportamento deles em silêncio, a regra virou parâmetro nomeado.

Deno.test("moverParaValidacao=false: carimba mas NÃO move (caso scan-email fora de AGUARDANDO_CLIENTE)", async () => {
  const cap = setup();
  // deno-lint-ignore no-explicit-any
  await acionarRespostaCliente(fakeSupabase(cap) as any, {
    cardId: "card-7",
    stateAnterior: "EXTRAVIO_MONITORADO",
    actorId: "scan-email-pre-card",
    moverParaValidacao: false,
  });
  const upd = cap.updates.find((u) => u.tabela === "cards")!;
  assertEquals(upd.state, undefined);
  assertEquals(upd.lock_aguardando_validacao, undefined);
  // o que importa: o carimbo e a limpeza da sugestão acontecem SEMPRE
  assertEquals(typeof upd.cliente_respondeu_em, "string");
  assertEquals(upd.ia_sugestao_oc_resposta, null);
});

Deno.test("moverParaValidacao=true força o movimento mesmo vindo de estado incomum", async () => {
  const cap = setup();
  // deno-lint-ignore no-explicit-any
  await acionarRespostaCliente(fakeSupabase(cap) as any, {
    cardId: "card-8",
    stateAnterior: "EM_TRIAGEM",
    actorId: "scan-email-pre-card",
    moverParaValidacao: true,
  });
  const upd = cap.updates.find((u) => u.tabela === "cards")!;
  assertEquals(upd.state, "AGUARDANDO_VALIDACAO_HUMANA");
  assertEquals(upd.lock_aguardando_validacao, true);
});

Deno.test("chamarInterpretador=false não chama a IA (scan-email re-enfileira depois)", async () => {
  const cap = setup();
  // deno-lint-ignore no-explicit-any
  const r = await acionarRespostaCliente(fakeSupabase(cap) as any, {
    cardId: "card-9",
    stateAnterior: "AGUARDANDO_CLIENTE",
    actorId: "scan-email-pre-card",
    chamarInterpretador: false,
  });
  assertEquals(r.interpretadorOk, false);
  const ev = cap.eventos.find((e) => e.tabela === "card_events")!;
  assertEquals((ev.payload as Record<string, unknown>).interpretador_disparado, false);
});

Deno.test("o evento reflete o que REALMENTE aconteceu com o state (não mente)", async () => {
  const cap = setup();
  // deno-lint-ignore no-explicit-any
  await acionarRespostaCliente(fakeSupabase(cap) as any, {
    cardId: "card-10",
    stateAnterior: "EXTRAVIO_MONITORADO",
    actorId: "scan-email-pre-card",
    moverParaValidacao: false,
  });
  const payload = cap.eventos[0].payload as Record<string, unknown>;
  assertEquals(payload.new_state, "EXTRAVIO_MONITORADO");
  assertEquals(payload.lock_aguardando_validacao, false);
});

Deno.test("default preservado: sem as políticas, comportamento é o do vinculador", async () => {
  const cap = setup();
  // deno-lint-ignore no-explicit-any
  await acionarRespostaCliente(fakeSupabase(cap) as any, {
    cardId: "card-11",
    stateAnterior: "AGUARDANDO_CLIENTE",
    actorId: "vinculador",
  });
  const upd = cap.updates.find((u) => u.tabela === "cards")!;
  assertEquals(upd.state, "AGUARDANDO_VALIDACAO_HUMANA");
  assertEquals(upd.acao_executada_em, null);
  assertEquals((cap.eventos[0].payload as Record<string, unknown>).interpretador_disparado, true);
});
