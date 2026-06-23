// Caio 2026-06-23: guard do GÊMEO "lançar só oc 54 SEM email".
// Garante que, ao lado da "54 + email" recomendada pela IA, sempre exista uma
// opção que lança SÓ a oc 54 no SSW sem disparar email (tool=lancar_ocorrencia,
// meta.sem_email_explicito=true). Restaura a opção que sumiu quando passamos a
// ter email de quase todo cliente. Âncoras: NF 352420 (oc=35), NF 775856 (oc=49).
//
// Cobre 4 cenários: (1) card novo cria com-email + gêmeo; (2) retroativo —
// card já 100% proposto ganha o gêmeo mesmo com propostasPendentes vazio;
// (3) fallback sem_email (template inativo) NÃO ganha gêmeo (já é sem email);
// (4) idempotência — não recria gêmeo já existente.
//
// Rodar: deno test supabase/functions/_shared/regras-auto-acao.sem-email-54.test.ts --allow-env

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { proporAutoAcaoSeAplicavel } from "./regras-auto-acao.ts";

interface PropostaPayload {
  tool: string;
  args: { codigo_ssw?: number; template_id?: string; email_destino?: string };
  meta?: {
    sem_email_explicito?: boolean;
    modo?: string;
    precisa_email_destino?: boolean;
    motivo_sem_email?: string;
  };
}
interface TodoInsert {
  descricao: string;
  proposta_payload: PropostaPayload;
}

function existingTodo(
  codigo: number,
  opts: { tool?: string; templateId?: string; meta?: Record<string, unknown>; tag?: string },
) {
  return {
    id: `ex-${codigo}-${opts.tag ?? ""}`,
    status: "pendente",
    proposta_payload: {
      tool: opts.tool ?? "lancar_ocorrencia",
      args: { codigo_ssw: codigo, ...(opts.templateId ? { template_id: opts.templateId } : {}) },
      meta: opts.meta ?? {},
    },
  };
}

function makeMock(opts: {
  existingTodos?: unknown[];
  templateAtivo?: boolean;
  emailDisponivel?: boolean;
}) {
  const todosInseridos: TodoInsert[] = [];
  let n = 0;
  const existing = opts.existingTodos ?? [];
  const templateAtivo = opts.templateAtivo ?? true;
  const emailDisponivel = opts.emailDisponivel ?? true;

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
    if (table === "todos") return existing;
    return [];
  }
  function resolveSingle(table: string): unknown {
    if (table === "templates_email") return { id: "tpl", ativo: templateAtivo };
    if (table === "cliente_config") return null; // não romaneio-interno
    return null;
  }
  function capture(table: string, obj: unknown) {
    if (table === "todos") todosInseridos.push(obj as TodoInsert);
  }

  const supabase = {
    from: (table: string) => builder(table),
    rpc: (_name: string) =>
      Promise.resolve({ data: emailDisponivel ? "contato@cliente.com" : null, error: null }),
    // deno-lint-ignore no-explicit-any
  } as any;

  return { supabase, todosInseridos };
}

const gemeos = (todos: TodoInsert[]) =>
  todos.filter(
    (t) => t.proposta_payload.args.codigo_ssw === 54 &&
      t.proposta_payload.meta?.sem_email_explicito === true,
  );

Deno.test("card novo (oc=49): cria 54+email E gêmeo 54 sem email", async () => {
  const { supabase, todosInseridos } = makeMock({ templateAtivo: true, emailDisponivel: true });
  await proporAutoAcaoSeAplicavel(supabase, {
    cardId: "card-novo",
    cardNf: "775856",
    cardCtrc: "PDV410927-9",
    codUltimaOc: 49,
    agentState: { cnpj_pagador: "123", cnpj_remetente: "123" },
    cardState: "AGUARDANDO_AGENTE",
    cardLock: false,
    actorId: "test",
  });

  const comEmail = todosInseridos.filter(
    (t) => t.proposta_payload.tool === "lancar_oc_e_enviar_email" &&
      t.proposta_payload.args.codigo_ssw === 54,
  );
  assertEquals(comEmail.length, 1, "deve criar a 54 + email (recomendada IA)");

  const g = gemeos(todosInseridos);
  assertEquals(g.length, 1, "deve criar exatamente 1 gêmeo 54 sem email");
  assertEquals(g[0].proposta_payload.tool, "lancar_ocorrencia", "gêmeo lança via lancar_ocorrencia");
  assertEquals(g[0].proposta_payload.args.template_id, undefined, "gêmeo NÃO carrega template_id");
  assertEquals(g[0].proposta_payload.meta?.modo, "sem_email");
  assert(/sem email/i.test(g[0].descricao), "descrição deixa claro que é sem email");
});

Deno.test("retroativo (oc=35, card 100% proposto): cria gêmeo mesmo sem propostas novas", async () => {
  const existing = [21, 55, 44, 56].map((c) => existingTodo(c, {}));
  existing.push(
    existingTodo(54, {
      tool: "lancar_oc_e_enviar_email",
      templateId: "RECUSA_PARCIAL",
      meta: { modo: "completo", tinha_intencao_email: true },
    }),
  );

  const { supabase, todosInseridos } = makeMock({ existingTodos: existing });
  await proporAutoAcaoSeAplicavel(supabase, {
    cardId: "card-althaia",
    cardNf: "352420",
    cardCtrc: "AP0205522-8",
    codUltimaOc: 35,
    agentState: { cnpj_pagador: "123" },
    cardState: "AGUARDANDO_VALIDACAO_HUMANA",
    cardLock: true,
    actorId: "test",
  });

  assertEquals(gemeos(todosInseridos).length, 1, "deve criar o gêmeo retroativamente (propostasPendentes vazio)");
});

Deno.test("fallback sem_email (template inativo): NÃO ganha gêmeo", async () => {
  const { supabase, todosInseridos } = makeMock({ templateAtivo: false, emailDisponivel: true });
  await proporAutoAcaoSeAplicavel(supabase, {
    cardId: "card-sem-tpl",
    cardNf: "111",
    codUltimaOc: 49,
    agentState: { cnpj_pagador: "123", cnpj_remetente: "123" },
    cardState: "AGUARDANDO_AGENTE",
    cardLock: false,
    actorId: "test",
  });

  assertEquals(gemeos(todosInseridos).length, 0, "fallback já é sem email — não duplicar");
  const oc54 = todosInseridos.filter((t) => t.proposta_payload.args.codigo_ssw === 54);
  assertEquals(oc54.length, 1, "deve haver só a 54 fallback (sem email)");
});

Deno.test("cliente SEM contato + template ATIVO: 54 vira '+ email' (precisa_email_destino), NÃO rebaixa", async () => {
  // Caio 2026-06-23 (NF 59354, MEDH sem contato): antes, sem email cadastrado a
  // 54 caía no fallback sem-email (tool=lancar_ocorrencia) e a operadora perdia a
  // opção de notificar. Agora mantém "54 + email" com destino em branco.
  const { supabase, todosInseridos } = makeMock({ templateAtivo: true, emailDisponivel: false });
  await proporAutoAcaoSeAplicavel(supabase, {
    cardId: "card-sem-contato",
    cardNf: "59354",
    cardCtrc: "AMB341957-6",
    codUltimaOc: 20,
    agentState: { cnpj_pagador: "18917657000183", cnpj_remetente: "18917657000183" },
    cardState: "AGUARDANDO_AGENTE",
    cardLock: false,
    actorId: "test",
  });

  const com54 = todosInseridos.filter((t) => t.proposta_payload.args.codigo_ssw === 54);
  const comEmail = com54.filter((t) => t.proposta_payload.tool === "lancar_oc_e_enviar_email");
  assertEquals(comEmail.length, 1, "deve criar a 54 + email (NÃO rebaixar pra lancar_ocorrencia)");
  const p = comEmail[0].proposta_payload;
  assertEquals(p.meta?.precisa_email_destino, true, "marca precisa_email_destino pro front exigir destinatário");
  assertEquals(p.meta?.modo, "completo", "modo completo (é a opção com email)");
  assertEquals(p.args.email_destino, undefined, "sem destino pré-resolvido — operadora preenche no modal");
  assertEquals(p.args.template_id, "FALTA_DE_VOLUME", "carrega o template do oc=20");
  assertEquals(p.meta?.motivo_sem_email, undefined, "NÃO é fallback sem-email");

  // O gêmeo "lançar só 54 sem email" continua sendo criado lado a lado.
  assertEquals(gemeos(todosInseridos).length, 1, "gêmeo sem-email criado ao lado da 54 + email");
});

Deno.test("idempotência: gêmeo já existe → não recria", async () => {
  const existing = [21, 55, 44, 56].map((c) => existingTodo(c, {}));
  existing.push(
    existingTodo(54, {
      tool: "lancar_oc_e_enviar_email",
      templateId: "RECUSA_PARCIAL",
      meta: { modo: "completo" },
    }),
    existingTodo(54, {
      tool: "lancar_ocorrencia",
      meta: { modo: "sem_email", sem_email_explicito: true },
      tag: "twin",
    }),
  );

  const { supabase, todosInseridos } = makeMock({ existingTodos: existing });
  await proporAutoAcaoSeAplicavel(supabase, {
    cardId: "card-ja-tem-twin",
    cardNf: "352420",
    codUltimaOc: 35,
    agentState: { cnpj_pagador: "123" },
    cardState: "AGUARDANDO_VALIDACAO_HUMANA",
    cardLock: true,
    actorId: "test",
  });

  assertEquals(gemeos(todosInseridos).length, 0, "não recria gêmeo já ativo");
});
