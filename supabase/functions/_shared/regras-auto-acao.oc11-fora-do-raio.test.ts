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

function makeMock(opts?: { todosExistentes?: Array<Record<string, unknown>> }) {
  const todosInseridos: TodoInsert[] = [];
  // updates capturados: { id do todo, payload novo }
  const todosAtualizados: Array<{ id: unknown; proposta_payload: Record<string, unknown> }> = [];
  const todosExistentes = opts?.todosExistentes ?? [];
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
          const ok = capture(table, state.insert);
          return Promise.resolve(
            ok
              ? { data: { id: `id-${++n}` }, error: null }
              : { data: null, error: { message: "duplicate key value violates unique constraint uniq_todos_card_tool_cod_ativo" } },
          );
        }
        return Promise.resolve({ data: resolveSingle(table), error: null });
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        let result: unknown;
        if (state.insert) {
          const ok = capture(table, state.insert);
          result = ok
            ? { data: { id: `id-${++n}` }, error: null }
            : { data: null, error: { message: "duplicate key value violates unique constraint uniq_todos_card_tool_cod_ativo" } };
        } else if (state.update) {
          captureUpdate(table, state.update, state.eqArgs);
          result = { data: null, error: null };
        } else {
          result = { data: table === "todos" ? todosExistentes : [], error: null };
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
  /**
   * Emula o índice único parcial de produção `uniq_todos_card_tool_cod_ativo`
   * (INV-030): INSERT de todo ATIVO com mesmo tool+codigo_ssw de um já
   * existente/inserido REBATE com erro de unique — em produção é o índice, não
   * o dedup, quem impede o gêmeo (o dedup pula meta.modo='sem_email' de
   * propósito, regra das 4 opções). Retorna false = insert rejeitado.
   */
  function capture(table: string, obj: unknown): boolean {
    if (table !== "todos") return true;
    const novo = obj as TodoInsert;
    const chave = (t: { proposta_payload: TodoInsert["proposta_payload"] }) =>
      `${t.proposta_payload?.tool}:${t.proposta_payload?.args?.codigo_ssw}`;
    const jaAtivo = [
      ...todosExistentes.filter((t) => ["pendente", "aprovado"].includes(String(t["status"]))),
      ...todosInseridos,
    ].some((t) => chave(t as TodoInsert) === chave(novo));
    if (jaAtivo) return false;
    todosInseridos.push(novo);
    return true;
  }
  function captureUpdate(table: string, obj: unknown, eqArgs: Array<[string, unknown]>) {
    if (table !== "todos") return;
    const idEq = eqArgs.find(([c]) => c === "id");
    todosAtualizados.push({
      id: idEq?.[1],
      proposta_payload: (obj as Record<string, unknown>)["proposta_payload"] as Record<string, unknown>,
    });
  }

  const supabase = {
    from: (table: string) => builder(table),
    rpc: (_n: string) => Promise.resolve({ data: "contato@cliente.com", error: null }),
    // deno-lint-ignore no-explicit-any
  } as any;
  return { supabase, todosInseridos, todosAtualizados };
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

// ---------------------------------------------------------------------------
// REPATCH do todo de 21 JÁ EXISTENTE (achado em produção 07/08: os 4 primeiros
// cards re-analisados — NFs 1357857/139908/29250/63467 — tinham o todo de 21
// criado ANTES do deploy, e o override só valia pro INSERT → pacote não chegava)
// ---------------------------------------------------------------------------

/** Todo de 21 "pelado" como os que existiam em produção antes do deploy. */
function todo21Existente(): Record<string, unknown> {
  return {
    id: "todo-21-velho",
    status: "pendente",
    proposta_payload: {
      tool: "lancar_ocorrencia",
      acao_key: "lancar_ocorrencia:21",
      args: {
        codigo_ssw: 21,
        nf: "139908",
        descricao: "Lançar oc 21 no SSW — reentrega solicitada pelo cliente",
      },
      meta: { modo: "sem_email" },
    },
  };
}

Deno.test("REPATCH: todo de 21 pré-existente ganha o pacote NO PRÓPRIO todo (sem gêmeo)", async () => {
  const { supabase, todosInseridos, todosAtualizados } = makeMock({
    todosExistentes: [todo21Existente()],
  });
  await proporAutoAcaoSeAplicavel(supabase, {
    ...baseArgsOc11,
    oc21ForaDoRaioOverride: OVERRIDE,
  });

  assertEquals(todosAtualizados.length, 1, "tem que ATUALIZAR o todo existente");
  assertEquals(todosAtualizados[0].id, "todo-21-velho");
  const pp = todosAtualizados[0].proposta_payload;
  const extras = ((pp["args"] as Record<string, unknown>)["extras"] ?? {}) as Record<string, unknown>;
  assertEquals(extras["cancelar_reentrega_24h"], true);
  assertEquals(extras["motivo_cancelamento"], "BAIXA FORA DO RAIO DE ENTREGA");
  assert(String(extras["texto_descricao"]).includes(TEXTO_SSW_BAIXA_DISTANTE));
  // preserva a identidade da ação (regra das 4 opções: nunca converter)
  assertEquals(pp["acao_key"], "lancar_ocorrencia:21");
  assertEquals((pp["args"] as Record<string, unknown>)["nf"], "139908");
  // e NÃO nasce um segundo todo de 21
  assertEquals(todo21(todosInseridos), undefined, "não pode criar gêmeo da 21");
});

Deno.test("REPATCH idempotente: todo já com o pacote → nenhum UPDATE", async () => {
  const jaPatchado = todo21Existente();
  const pp = jaPatchado["proposta_payload"] as Record<string, unknown>;
  (pp["args"] as Record<string, unknown>)["extras"] = {
    texto_descricao: OVERRIDE.textoSsw,
    cancelar_reentrega_24h: true,
    motivo_cancelamento: OVERRIDE.motivoCancelamento,
  };
  const { supabase, todosAtualizados } = makeMock({ todosExistentes: [jaPatchado] });
  await proporAutoAcaoSeAplicavel(supabase, {
    ...baseArgsOc11,
    oc21ForaDoRaioOverride: OVERRIDE,
  });
  assertEquals(todosAtualizados.length, 0, "já patchado → no-op, sem UPDATE nem evento");
});

Deno.test("ÂNCORA anti-vazamento: todo de 21 existente SEM override fica intocado", async () => {
  const { supabase, todosAtualizados } = makeMock({
    todosExistentes: [todo21Existente()],
  });
  await proporAutoAcaoSeAplicavel(supabase, baseArgsOc11); // sem override
  assertEquals(
    todosAtualizados.length,
    0,
    "sem override o repatch não roda — senão sync-bastao/vinculador cancelariam reentrega legítima",
  );
});
