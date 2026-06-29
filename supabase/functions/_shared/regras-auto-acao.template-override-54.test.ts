// Caio 2026-06-29 (NF 705764, β): a ação clicável "54 + e-mail" deve carregar o
// template QUE O AGENTE DECIDIU (templateEmail54Override, ex:
// EXTRAVIO_TOTAL_PEDIR_ROMANEIO no extravio) — NÃO o FALTA_DE_VOLUME genérico da
// regra oc=49. Sem o override, comportamento idêntico ao de hoje (zero regressão).
// O override SÓ vale pra proposta codigo_ssw=54 que já tem e-mail — nunca cria
// e-mail onde a regra não previa nem mexe nas outras propostas.
//
// Rodar: deno test supabase/functions/_shared/regras-auto-acao.template-override-54.test.ts --allow-env

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { proporAutoAcaoSeAplicavel } from "./regras-auto-acao.ts";

interface TodoInsert {
  proposta_payload: {
    tool: string;
    args?: { codigo_ssw?: number; template_id?: string };
    meta?: { modo?: string; tinha_intencao_email?: boolean };
  };
}

function makeMock() {
  const todosInseridos: TodoInsert[] = [];
  let n = 0;

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
    if (table === "cliente_config") return null; // sem romaneio-interno
    if (table === "templates_email") return { id: "tpl", ativo: true }; // qualquer template ativo
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
  cardNf: "705764",
  cardCtrc: "APO354016-2",
  codUltimaOc: 49,
  agentState: { cnpj_pagador: "00874929000140", cnpj_remetente: "00874929000140" },
  cardState: "AGUARDANDO_AGENTE",
  cardLock: false,
  actorId: "test",
};

function todo54ComEmail(todos: TodoInsert[]): TodoInsert | undefined {
  return todos.find(
    (t) =>
      t.proposta_payload.tool === "lancar_oc_e_enviar_email" &&
      t.proposta_payload.args?.codigo_ssw === 54,
  );
}

Deno.test("β: COM override de extravio → 54+email carrega EXTRAVIO_TOTAL_PEDIR_ROMANEIO", async () => {
  const { supabase, todosInseridos } = makeMock();
  await proporAutoAcaoSeAplicavel(supabase, {
    ...baseArgs,
    templateEmail54Override: "EXTRAVIO_TOTAL_PEDIR_ROMANEIO",
  });

  const t54 = todo54ComEmail(todosInseridos);
  assert(t54, "deve criar a ação '54 + e-mail'");
  assertEquals(
    t54!.proposta_payload.args?.template_id,
    "EXTRAVIO_TOTAL_PEDIR_ROMANEIO",
    "template do 54+email deve ser o decidido pelo agente, não FALTA_DE_VOLUME",
  );
});

Deno.test("β: SEM override → 54+email mantém o FALTA_DE_VOLUME genérico (zero regressão)", async () => {
  const { supabase, todosInseridos } = makeMock();
  await proporAutoAcaoSeAplicavel(supabase, baseArgs); // sem templateEmail54Override

  const t54 = todo54ComEmail(todosInseridos);
  assert(t54, "deve criar a ação '54 + e-mail'");
  assertEquals(
    t54!.proposta_payload.args?.template_id,
    "FALTA_DE_VOLUME",
    "sem override, mantém o template padrão da regra oc=49",
  );
});

Deno.test("β: override NÃO cria e-mail em proposta que não previa (só toca a 54+email)", async () => {
  const { supabase, todosInseridos } = makeMock();
  await proporAutoAcaoSeAplicavel(supabase, {
    ...baseArgs,
    templateEmail54Override: "EXTRAVIO_TOTAL_PEDIR_ROMANEIO",
  });

  // Nenhuma proposta sem e-mail (21/55/44/56/41) pode ter virado "+ e-mail" por causa do override.
  const naoEmail = todosInseridos.filter(
    (t) =>
      t.proposta_payload.args?.codigo_ssw != null &&
      t.proposta_payload.args.codigo_ssw !== 54 &&
      t.proposta_payload.tool === "lancar_ocorrencia",
  );
  for (const t of naoEmail) {
    assertEquals(
      t.proposta_payload.args?.template_id,
      undefined,
      `proposta ${t.proposta_payload.args?.codigo_ssw} não pode ganhar template por causa do override`,
    );
  }
});
