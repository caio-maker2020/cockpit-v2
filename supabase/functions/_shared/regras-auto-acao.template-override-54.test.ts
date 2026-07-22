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

function makeMock(opts?: { todosExistentes?: unknown[] }) {
  const todosInseridos: TodoInsert[] = [];
  // deno-lint-ignore no-explicit-any
  const todosAtualizados: Array<{ id: unknown; proposta_payload: any }> = [];
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
          captureUpdate(table, state.update, state.eqArgs);
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
    if (table === "todos") return todosExistentes; // todos ATIVOS do card (default [])
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

  function captureUpdate(table: string, obj: unknown, eqArgs: Array<[string, unknown]>) {
    if (table !== "todos") return;
    const idEq = eqArgs.find(([c]) => c === "id");
    // deno-lint-ignore no-explicit-any
    todosAtualizados.push({ id: idEq?.[1], proposta_payload: (obj as any).proposta_payload });
  }

  const supabase = {
    from: (table: string) => builder(table),
    rpc: (_name: string) => Promise.resolve({ data: "contato@cliente.com", error: null }),
    // deno-lint-ignore no-explicit-any
  } as any;

  return { supabase, todosInseridos, todosAtualizados };
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

// Caio 2026-07-13 (separação 54/59): oc=19 (entrega com falta) agora propõe 59
// (RETORNO INDENIZAÇÃO), não 54 — REGRAS_AUTO_ACAO[19].codigo_ssw_proposto = 59.
function todo59ComEmail(todos: TodoInsert[]): TodoInsert | undefined {
  return todos.find(
    (t) =>
      t.proposta_payload.tool === "lancar_oc_e_enviar_email" &&
      t.proposta_payload.args?.codigo_ssw === 59,
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

// ===========================================================================
// Codex 2026-07-02 (NF 609867) — A) default oc=19 + B/C) repatch idempotente.
// ===========================================================================

const argsOc19 = { ...baseArgs, cardNf: "609867", codUltimaOc: 19 };

function todo54ExistenteFalta(): Record<string, unknown> {
  return {
    id: "todo-54",
    status: "pendente",
    proposta_payload: {
      tool: "lancar_oc_e_enviar_email",
      args: { codigo_ssw: 54, template_id: "FALTA_DE_VOLUME", email_destino: "cliente@x.com" },
      meta: { modo: "completo", tinha_intencao_email: true },
      acao_key: "lancar_oc_e_enviar_email:54",
    },
  };
}

// Teste 1
Deno.test("A — oc=19 SEM override → 59+email criado com ENTREGUE_COM_FALTA_PEDIR_ROMANEIO (separação 54/59)", async () => {
  const { supabase, todosInseridos } = makeMock();
  await proporAutoAcaoSeAplicavel(supabase, argsOc19);
  // Caio 2026-07-13: oc=19 = entrega com falta = INDENIZAÇÃO → agora 59 (era 54).
  const t59 = todo59ComEmail(todosInseridos);
  assert(t59, "deve criar a ação '59 + e-mail'");
  assertEquals(t59!.proposta_payload.args?.codigo_ssw, 59);
  assertEquals(t59!.proposta_payload.args?.template_id, "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO");
  // não deve criar um 54+email (o trilho mudou pra 59)
  assertEquals(todo54ComEmail(todosInseridos), undefined);
});

// Teste 2
Deno.test("B/C — todo 54+email ATIVO com FALTA_DE_VOLUME + override ENTREGUE → ATUALIZA o mesmo todo, não cria outro", async () => {
  const { supabase, todosInseridos, todosAtualizados } = makeMock({ todosExistentes: [todo54ExistenteFalta()] });
  await proporAutoAcaoSeAplicavel(supabase, { ...argsOc19, templateEmail54Override: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO" });
  // atualizou o MESMO todo
  assertEquals(todosAtualizados.length, 1);
  assertEquals(todosAtualizados[0]!.id, "todo-54");
  assertEquals(todosAtualizados[0]!.proposta_payload.args.template_id, "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO");
  // preservou email_destino + acao_key + meta
  assertEquals(todosAtualizados[0]!.proposta_payload.args.email_destino, "cliente@x.com");
  assertEquals(todosAtualizados[0]!.proposta_payload.acao_key, "lancar_oc_e_enviar_email:54");
  assertEquals(todosAtualizados[0]!.proposta_payload.meta.modo, "completo");
  // NÃO criou outro 54+email (dedup por código exclui o 54 de propostasPendentes)
  const inseridos54 = todosInseridos.filter(
    (t) => t.proposta_payload.tool === "lancar_oc_e_enviar_email" && t.proposta_payload.args?.codigo_ssw === 54,
  );
  assertEquals(inseridos54.length, 0);
});

// Teste 3
Deno.test("B — idempotente: todo já com ENTREGUE + override igual → NÃO atualiza de novo", async () => {
  const jaEntregue = todo54ExistenteFalta();
  (jaEntregue.proposta_payload as { args: { template_id: string } }).args.template_id = "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO";
  const { supabase, todosAtualizados } = makeMock({ todosExistentes: [jaEntregue] });
  await proporAutoAcaoSeAplicavel(supabase, { ...argsOc19, templateEmail54Override: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO" });
  assertEquals(todosAtualizados.length, 0);
});

// Teste 4
Deno.test("B — override NÃO toca 54 SEM e-mail nem outros códigos (repatch não atualiza)", async () => {
  const semEmail = {
    id: "todo-54-sem",
    status: "pendente",
    proposta_payload: { tool: "lancar_ocorrencia", args: { codigo_ssw: 54 }, meta: { sem_email_explicito: true } },
  };
  const outro = { id: "todo-21", status: "pendente", proposta_payload: { tool: "lancar_ocorrencia", args: { codigo_ssw: 21 } } };
  const { supabase, todosAtualizados } = makeMock({ todosExistentes: [semEmail, outro] });
  await proporAutoAcaoSeAplicavel(supabase, { ...argsOc19, templateEmail54Override: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO" });
  assertEquals(todosAtualizados.length, 0, "repatch só toca tool=lancar_oc_e_enviar_email codigo=54");
});

// Teste 7 — Codex 2026-07-03 (NF 156761): repatch roda ANTES do state-gate →
// corrige card em AGUARDANDO_CLIENTE (o gate barra criação de proposta nova, mas o
// template do todo existente É atualizado). Antes o repatch ficava depois do gate,
// que dá return p/ AGUARDANDO_CLIENTE → só o backfill corrigia.
Deno.test("B — repatch ANTES do gate: card AGUARDANDO_CLIENTE + override → atualiza template, NÃO cria proposta", async () => {
  const { supabase, todosInseridos, todosAtualizados } = makeMock({ todosExistentes: [todo54ExistenteFalta()] });
  await proporAutoAcaoSeAplicavel(supabase, {
    ...argsOc19,
    cardState: "AGUARDANDO_CLIENTE",
    templateEmail54Override: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
  });
  assertEquals(todosAtualizados.length, 1, "repatcha mesmo em AGUARDANDO_CLIENTE");
  assertEquals(todosAtualizados[0]!.proposta_payload.args.template_id, "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO");
  assertEquals(todosInseridos.length, 0, "state-gate barra criação de proposta nova — só o repatch rodou");
});

// Teste 5
Deno.test("Regressão — oc=49 SEM override continua FALTA_DE_VOLUME (default da 49 intacto)", async () => {
  const { supabase, todosInseridos } = makeMock();
  await proporAutoAcaoSeAplicavel(supabase, baseArgs); // codUltimaOc=49, sem override
  const t54 = todo54ComEmail(todosInseridos);
  assert(t54, "deve criar 54+email");
  assertEquals(t54!.proposta_payload.args?.template_id, "FALTA_DE_VOLUME");
});

// Teste 6 — Emenda 1 (placeholders): o executor resolve TODAS as variáveis de
// ENTREGUE_COM_FALTA_PEDIR_ROMANEIO no envio (renderTemplate: vars[key] ?? "{key}"),
// degradando a "" quando falta — nunca deixa "{n_volumes_falta}"/"{link_evidencia}"
// literal. Espelha executor/index.ts:1827-1845 (guardado também no /verify-cockpit).
const VARS_RESOLVIDAS_EXECUTOR = new Set([
  "nome_cliente", "primeiro_nome", "saudacao", "nf", "empresa", "operadora_nome",
  "cidade_destino", "previsao_atual", "descricao_problema", "n_volumes_falta", "qtde_volumes", "link_evidencia",
]);
// Placeholders do corpo de ENTREGUE_COM_FALTA_PEDIR_ROMANEIO (verbatim do banco, mig 210).
const VARS_TEMPLATE_ENTREGUE = ["primeiro_nome", "nf", "n_volumes_falta", "link_evidencia", "operadora_nome"];

Deno.test("Emenda 1 — ENTREGUE_COM_FALTA_PEDIR_ROMANEIO: toda variável é resolvida pelo executor (sem placeholder literal)", () => {
  const render = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? `{${k}}`);
  // (a) toda variável do template está no set resolvível → nenhuma vira literal no envio.
  for (const v of VARS_TEMPLATE_ENTREGUE) {
    assert(VARS_RESOLVIDAS_EXECUTOR.has(v), `variável {${v}} do template precisa ser resolvida pelo executor`);
  }
  // (b) contrato do render: mesmo VAZIO (sem qtd / sem foto) degrada a "" — nunca literal.
  const corpo = "entrega da NF {nf} com falta de {n_volumes_falta} volume(s). Evidência: {link_evidencia}. {operadora_nome}";
  const out = render(corpo, { nf: "609867", n_volumes_falta: "", link_evidencia: "", operadora_nome: "DUILIO" });
  assert(!out.includes("{n_volumes_falta}"), "n_volumes_falta não pode sair literal");
  assert(!out.includes("{link_evidencia}"), "link_evidencia não pode sair literal");
});
