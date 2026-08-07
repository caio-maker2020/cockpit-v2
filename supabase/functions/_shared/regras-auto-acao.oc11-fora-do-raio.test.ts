// OC 11 FORA DO RAIO (Isadora 07/08 — "Padronização Ocorrência 11";
// texto exigido pelo Caio 07/08).
//
// Acima de 4.000 m o lançamento é improcedente: a tratativa é oc 21 CANCELANDO
// a reentrega, e a Operação precisa LER no SSW por que a reentrega parou.
// Os extras vão no PRÓPRIO todo (args.extras) e não só em meta — prefill de
// front é editável e pode ser limpo (classe INV-041/046, "aprovação às cegas",
// que já lançou 56 com casca vazia na NF 62566).
//
// O QUE ESTE ARQUIVO TRAVA: o mecanismo cancelar_reentrega_24h é COMPARTILHADO
// com o vinculador e o agente da oc 13. Se vazar pra qualquer proposta de 21,
// cancelaríamos reentrega legítima em todo card. Idem texto_descricao, que
// SUBSTITUI a descrição inteira (regressão NF 59299 na oc 44).
//
// Rodar: deno test supabase/functions/_shared/regras-auto-acao.oc11-fora-do-raio.test.ts --allow-env

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { proporAutoAcaoSeAplicavel } from "./regras-auto-acao.ts";
import { TEXTO_SSW_BAIXA_DISTANTE } from "./oc11-raio-regras.ts";

interface TodoInsert {
  proposta_payload: {
    tool: string;
    args?: { codigo_ssw?: number; extras?: Record<string, unknown> };
    meta?: Record<string, unknown>;
  };
}

function makeMock() {
  const todosInseridos: TodoInsert[] = [];
  let n = 0;

  function builder(table: string) {
    const state: { insert?: unknown; update?: unknown; eqArgs: Array<[string, unknown]> } = { eqArgs: [] };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col?: string, val?: unknown) => {
        if (typeof col === "string") state.eqArgs.push([col, val]);
        return b;
      },
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
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        let result: unknown;
        if (state.insert) {
          capture(table, state.insert);
          result = { data: { id: `id-${++n}` }, error: null };
        } else {
          result = { data: table === "todos" ? [] : [], error: null };
        }
        return Promise.resolve(result).then(onF, onR);
      },
    };
    return b;
  }

  function resolveSingle(table: string): unknown {
    if (table === "cliente_config") return null;
    if (table === "templates_email") return { id: "tpl", ativo: true };
    return null;
  }
  function capture(table: string, obj: unknown) {
    if (table === "todos") todosInseridos.push(obj as TodoInsert);
  }

  const supabase = {
    from: (table: string) => builder(table),
    rpc: (_n: string) => Promise.resolve({ data: "contato@cliente.com", error: null }),
    // deno-lint-ignore no-explicit-any
  } as any;
  return { supabase, todosInseridos };
}

const baseArgsOc11 = {
  cardId: "card-oc11",
  cardNf: "371193",
  cardCtrc: "ABC123456-7",
  codUltimaOc: 11,
  agentState: { cnpj_pagador: "00874929000140", cnpj_remetente: "00874929000140" },
  cardState: "AGUARDANDO_VALIDACAO_HUMANA",
  cardLock: true,
  actorId: "test-oc11",
};

const OVERRIDE = {
  textoSsw: `${TEXTO_SSW_BAIXA_DISTANTE} - GPS 8500M`,
  motivoCancelamento: "BAIXA FORA DO RAIO DE ENTREGA",
};

const todo21 = (todos: TodoInsert[]) =>
  todos.find((t) => t.proposta_payload.args?.codigo_ssw === 21);

Deno.test("COM override: o todo da 21 leva o texto pro SSW e marca o cancelamento", async () => {
  const { supabase, todosInseridos } = makeMock();
  await proporAutoAcaoSeAplicavel(supabase, {
    ...baseArgsOc11,
    oc21ForaDoRaioOverride: OVERRIDE,
  });

  const t21 = todo21(todosInseridos);
  assert(t21, "a oc 11 tem que propor a opção 21");
  const extras = t21!.proposta_payload.args?.extras as Record<string, unknown>;
  assert(extras, "a proposta da 21 precisa carregar extras");
  assertEquals(extras["cancelar_reentrega_24h"], true, "TEM que marcar cancelamento");
  assertEquals(extras["motivo_cancelamento"], "BAIXA FORA DO RAIO DE ENTREGA");
  assert(
    String(extras["texto_descricao"]).includes(TEXTO_SSW_BAIXA_DISTANTE),
    `texto do SSW precisa conter a frase literal — veio: ${extras["texto_descricao"]}`,
  );
});

Deno.test("ÂNCORA anti-vazamento: SEM override, a 21 sai limpa (comportamento de hoje)", async () => {
  const { supabase, todosInseridos } = makeMock();
  await proporAutoAcaoSeAplicavel(supabase, baseArgsOc11); // sem override

  const t21 = todo21(todosInseridos);
  assert(t21, "a opção 21 continua existindo no menu da oc 11");
  const extras = (t21!.proposta_payload.args?.extras ?? {}) as Record<string, unknown>;
  assertEquals(
    extras["cancelar_reentrega_24h"],
    undefined,
    "sem override NÃO pode marcar cancelamento — vazaria pro vinculador e pro agente da oc 13",
  );
  assertEquals(extras["texto_descricao"], undefined, "sem override não injeta texto");
});

Deno.test("ÂNCORA anti-vazamento: o override NÃO contamina as outras propostas do card", async () => {
  const { supabase, todosInseridos } = makeMock();
  await proporAutoAcaoSeAplicavel(supabase, {
    ...baseArgsOc11,
    oc21ForaDoRaioOverride: OVERRIDE,
  });

  const outras = todosInseridos.filter((t) => t.proposta_payload.args?.codigo_ssw !== 21);
  assert(outras.length > 0, "a oc 11 propõe mais opções além da 21");
  for (const t of outras) {
    const extras = (t.proposta_payload.args?.extras ?? {}) as Record<string, unknown>;
    const cod = t.proposta_payload.args?.codigo_ssw;
    assertEquals(
      extras["cancelar_reentrega_24h"],
      undefined,
      `oc ${cod} não pode herdar o cancelamento`,
    );
    assertEquals(
      extras["texto_descricao"],
      undefined,
      `oc ${cod} não pode herdar texto_descricao (substituiria a descrição — NF 59299)`,
    );
  }
});

Deno.test("o front recebe o espelho em meta (texto + checkbox já marcado)", async () => {
  const { supabase, todosInseridos } = makeMock();
  await proporAutoAcaoSeAplicavel(supabase, {
    ...baseArgsOc11,
    oc21ForaDoRaioOverride: OVERRIDE,
  });
  const meta = todo21(todosInseridos)!.proposta_payload.meta ?? {};
  assert(String(meta["texto_ssw_sugerido"]).includes(TEXTO_SSW_BAIXA_DISTANTE));
  assertEquals(meta["cancelar_reentrega_sugerido"], true);
});
