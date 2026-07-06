// Caio 2026-06-22: verifica que cliente romaneio-interno (PRATI) recebe
//   (a) proposta de romaneio marcada `recomendada: true`, e
//   (b) `aviso_romaneio_interno` em CADA proposta genérica que lança oc 33.
// Mock mínimo do SupabaseClient (captura os todos inseridos). Sem rede/DB.
//
// Rodar: deno test supabase/functions/_shared/regras-auto-acao.romaneio.test.ts --allow-env

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { proporAutoAcaoSeAplicavel } from "./regras-auto-acao.ts";

interface TodoInsert {
  proposta_payload: {
    tool: string;
    recomendada?: boolean;
    aviso_romaneio_interno?: string;
    args?: { codigo_ssw?: number };
  };
}

function makeMock(opts: { romaneioInterno: boolean }) {
  const todosInseridos: TodoInsert[] = [];
  let n = 0;

  // Builder chainável + thenable. Métodos não-terminais retornam `this`.
  function builder(table: string) {
    const state: { insert?: unknown; update?: unknown } = {};
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      insert: (obj: unknown) => {
        state.insert = obj;
        return b;
      },
      update: (obj: unknown) => {
        state.update = obj;
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: resolveSingle(table), error: null }),
      single: () => {
        if (state.insert) {
          capture(table, state.insert);
          return Promise.resolve({ data: { id: `id-${++n}` }, error: null });
        }
        return Promise.resolve({ data: resolveSingle(table), error: null });
      },
      // awaited direto (select.eq, insert sem single, update.eq)
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        let result: unknown;
        if (state.insert) {
          capture(table, state.insert);
          result = { data: { id: `id-${++n}` }, error: null };
        } else if (state.update) {
          result = { data: null, error: null };
        } else {
          result = { data: resolveMany(table), error: null };
        }
        return Promise.resolve(result).then(onF, onR);
      },
    };
    return b;
  }

  function resolveMany(table: string): unknown[] {
    if (table === "todos") return []; // card novo, nenhum todo ativo
    return [];
  }

  function resolveSingle(table: string): unknown {
    if (table === "cliente_config") {
      return opts.romaneioInterno
        ? {
          usa_romaneio_interno: true,
          template_email_extravio_total: "EXTRAVIO_TOTAL_NOTIFICACAO",
          nome_cliente: "PRATI",
        }
        : null;
    }
    if (table === "templates_email") return { id: "tpl", ativo: true };
    return null;
  }

  function capture(table: string, obj: unknown) {
    if (table === "todos") todosInseridos.push(obj as TodoInsert);
  }

  const supabase = {
    from: (table: string) => builder(table),
    rpc: (_name: string) => Promise.resolve({ data: "contato@cliente.com", error: null }),
    // deno-lint-ignore no-explicit-any
  } as any;

  return { supabase, todosInseridos };
}

const baseArgs = {
  cardId: "card-1",
  cardNf: "1007453",
  cardCtrc: "PRT237422-6",
  codUltimaOc: 49,
  agentState: { cnpj_pagador: "73856593001057", cnpj_remetente: "73856593001057" },
  cardState: "AGUARDANDO_AGENTE",
  cardLock: false,
  actorId: "test",
};

Deno.test("PRATI (romaneio-interno): romaneio recomendada + aviso nas 33 genéricas", async () => {
  const { supabase, todosInseridos } = makeMock({ romaneioInterno: true });
  await proporAutoAcaoSeAplicavel(supabase, baseArgs);

  const romaneio = todosInseridos.find(
    (t) => t.proposta_payload.tool === "enviar_email_e_lancar_33_romaneio_interno",
  );
  assert(romaneio, "deve criar o todo de romaneio");
  assertEquals(romaneio!.proposta_payload.recomendada, true, "romaneio deve ser recomendada");

  const generic33 = todosInseridos.filter(
    (t) =>
      t.proposta_payload.tool !== "enviar_email_e_lancar_33_romaneio_interno" &&
      (t.proposta_payload.args?.codigo_ssw === 33 || /33/.test(t.proposta_payload.tool)),
  );
  assert(generic33.length >= 1, "deve haver ao menos uma 33 genérica");
  for (const g of generic33) {
    assert(
      typeof g.proposta_payload.aviso_romaneio_interno === "string" &&
        g.proposta_payload.aviso_romaneio_interno.includes("romaneio interno"),
      `33 genérica (${g.proposta_payload.tool}) deve ter aviso_romaneio_interno`,
    );
  }
});

Deno.test("Cliente comum (NÃO romaneio-interno): nenhum campo novo", async () => {
  const { supabase, todosInseridos } = makeMock({ romaneioInterno: false });
  await proporAutoAcaoSeAplicavel(supabase, baseArgs);

  assert(
    !todosInseridos.some((t) => t.proposta_payload.tool === "enviar_email_e_lancar_33_romaneio_interno"),
    "não deve criar todo de romaneio",
  );
  assert(
    todosInseridos.every((t) => t.proposta_payload.recomendada === undefined),
    "nenhum todo deve ser recomendada",
  );
  assert(
    todosInseridos.every((t) => t.proposta_payload.aviso_romaneio_interno === undefined),
    "nenhum todo deve ter aviso_romaneio_interno",
  );
});
