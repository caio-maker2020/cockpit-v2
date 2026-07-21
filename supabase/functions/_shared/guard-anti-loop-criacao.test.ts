// Testes do guard anti-loop de fabricação de cards (INV-040, caso âncora NF 2084).
// Rodar: deno test supabase/functions/_shared/guard-anti-loop-criacao.test.ts
//
// Mock de supabase no estilo reconciliar-extravios-bastao.test.ts: from(table)
// devolve builder awaitable; respostas de count/maybeSingle parametrizadas por
// teste. O que importa provar:
//   1. 3 terminais em 24h → a 4ª criação é BLOQUEADA + evento de anomalia;
//   2. abaixo do limite → criação segue, zero side-effects;
//   3. dedupe: evento já emitido nas últimas 24h → bloqueia SEM novo evento;
//   4. fail-open: erro de banco no guard → criação segue (sync nunca cai).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bloquearCriacaoSeLoopDetectado,
  EVENTO_LOOP_DETECTADO,
  excedeuLimiteLoopCriacao,
  LIMITE_TERMINAIS_24H,
  montarPayloadLoopDetectado,
} from "./guard-anti-loop-criacao.ts";

interface Call {
  table: string;
  op: string;
  payload?: Record<string, unknown>;
}

function makeMock(opts: {
  qtdTerminais?: number;
  qtdTerminaisError?: string;
  eventosJaEmitidos?: number;
  cardRecenteId?: string | null;
}): { supabase: unknown; calls: Call[] } {
  const calls: Call[] = [];
  function from(table: string): Record<string, unknown> {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() {
        return b;
      },
      insert(payload: Record<string, unknown>) {
        calls.push({ table, op: "insert", payload });
        return Promise.resolve({ error: null });
      },
      eq() {
        return b;
      },
      in() {
        return b;
      },
      gte() {
        return b;
      },
      order() {
        return b;
      },
      limit() {
        return b;
      },
      maybeSingle() {
        return Promise.resolve({
          data: opts.cardRecenteId ? { id: opts.cardRecenteId } : null,
          error: null,
        });
      },
      // deno-lint-ignore no-explicit-any
      then(resolve: (v: unknown) => any) {
        if (table === "cards") {
          return Promise.resolve(
            opts.qtdTerminaisError
              ? { count: null, error: { message: opts.qtdTerminaisError } }
              : { count: opts.qtdTerminais ?? 0, error: null },
          ).then(resolve);
        }
        return Promise.resolve({ count: opts.eventosJaEmitidos ?? 0, error: null }).then(resolve);
      },
    };
    return b;
  }
  return { supabase: { from }, calls };
}

const eventosInseridos = (calls: Call[]) =>
  calls.filter((c) => c.table === "card_events" && c.op === "insert");

Deno.test("excedeuLimiteLoopCriacao: abaixo do limite → false; no limite ou acima → true", () => {
  assertEquals(excedeuLimiteLoopCriacao(0), false);
  assertEquals(excedeuLimiteLoopCriacao(1), false);
  assertEquals(excedeuLimiteLoopCriacao(2), false);
  assertEquals(excedeuLimiteLoopCriacao(3), true, "3 terminais = limite atingido, 4ª criação bloqueia");
  assertEquals(excedeuLimiteLoopCriacao(74), true, "rajada NF 2084");
  assertEquals(excedeuLimiteLoopCriacao(NaN), false, "NaN nunca bloqueia (fail-open)");
  assertEquals(excedeuLimiteLoopCriacao(1, 1), true, "limite customizado");
  assertEquals(LIMITE_TERMINAIS_24H, 3);
});

Deno.test("RAJADA (caso âncora NF 2084): 3 terminais em 24h → 4ª criação BLOQUEADA + LoopCriacaoCardDetectado", async () => {
  const { supabase, calls } = makeMock({ qtdTerminais: 3, cardRecenteId: "card-recente" });
  // deno-lint-ignore no-explicit-any
  const bloqueado = await bloquearCriacaoSeLoopDetectado(supabase as any, {
    nf: "2084",
    origem: "bastao",
    ctrc: "AMB054756-5",
  });
  assertEquals(bloqueado, true, "criação deve ser bloqueada");
  const evs = eventosInseridos(calls);
  assertEquals(evs.length, 1, "exatamente 1 evento de anomalia");
  assertEquals(evs[0].payload?.event_type, EVENTO_LOOP_DETECTADO);
  assertEquals(evs[0].payload?.card_id, "card-recente", "evento vai no card mais recente da NF");
  const payload = evs[0].payload?.payload as Record<string, unknown>;
  assertEquals(payload.nf, "2084");
  assertEquals(payload.origem, "bastao");
  assertEquals(payload.qtd_terminais_24h, 3);
});

Deno.test("origem extravio também bloqueia (os DOIS pontos de criação do sync usam o guard)", async () => {
  const { supabase, calls } = makeMock({ qtdTerminais: 5, cardRecenteId: "card-x" });
  // deno-lint-ignore no-explicit-any
  const bloqueado = await bloquearCriacaoSeLoopDetectado(supabase as any, {
    nf: "2084",
    origem: "extravio",
    ctrc: "TTO417705-3",
  });
  assertEquals(bloqueado, true);
  const payload = eventosInseridos(calls)[0].payload?.payload as Record<string, unknown>;
  assertEquals(payload.origem, "extravio");
});

Deno.test("abaixo do limite (2 terminais) → criação SEGUE, zero side-effects", async () => {
  const { supabase, calls } = makeMock({ qtdTerminais: 2, cardRecenteId: "card-y" });
  // deno-lint-ignore no-explicit-any
  const bloqueado = await bloquearCriacaoSeLoopDetectado(supabase as any, {
    nf: "111",
    origem: "bastao",
  });
  assertEquals(bloqueado, false, "re-ocorrência legítima nunca é bloqueada");
  assertEquals(calls.length, 0, "nenhum insert/update");
});

Deno.test("dedupe: evento já emitido nas últimas 24h → bloqueia SEM novo evento (sem flood)", async () => {
  const { supabase, calls } = makeMock({
    qtdTerminais: 4,
    eventosJaEmitidos: 1,
    cardRecenteId: "card-z",
  });
  // deno-lint-ignore no-explicit-any
  const bloqueado = await bloquearCriacaoSeLoopDetectado(supabase as any, {
    nf: "2084",
    origem: "bastao",
  });
  assertEquals(bloqueado, true, "segue bloqueando");
  assertEquals(eventosInseridos(calls).length, 0, "mas não re-emite o evento");
});

Deno.test("FAIL-OPEN: erro de banco no count → criação segue (guard nunca derruba o sync)", async () => {
  const { supabase, calls } = makeMock({ qtdTerminaisError: "connection reset" });
  // deno-lint-ignore no-explicit-any
  const bloqueado = await bloquearCriacaoSeLoopDetectado(supabase as any, {
    nf: "222",
    origem: "bastao",
  });
  assertEquals(bloqueado, false, "erro no guard NÃO pode bloquear criação legítima");
  assertEquals(eventosInseridos(calls).length, 0);
});

Deno.test("payload do evento documenta o motivo (INV-040 + caso âncora)", () => {
  const p = montarPayloadLoopDetectado({
    nf: "2084",
    origem: "bastao",
    ctrc: "AMB054756-5",
    qtdTerminais24h: 74,
    limite: 3,
  });
  assert(String(p.motivo).includes("INV-040"));
  assert(String(p.motivo).includes("2084"), "caso âncora citado");
  assertEquals(p.qtd_terminais_24h, 74);
  assertEquals(p.ctrc_pendencia, "AMB054756-5");
});
