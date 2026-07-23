// Guard INV-047 — REGRA 4 OPÇÕES (Caio 2026-07-23, NF 1100040): o repatch mira
// o todo do TRILHO DESTACADO e troca só o template. NUNCA converte 54↔59 (a
// conversão comia a opção 54+email do card — as 4 opções são invioláveis:
// 54±email e 59±email sempre; agente sugere, operadora decide, loop aprende).
// Rodar: deno test --allow-env supabase/functions/_shared/repatch-trilho.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { repatcharTemplateEmail54Existente } from "./regras-auto-acao.ts";

function mockSupabase() {
  const capturado: { update?: Record<string, unknown>; updateTodoId?: string; evento?: Record<string, unknown> } = {};
  const supabase = {
    from(tabela: string) {
      return {
        update(payload: Record<string, unknown>) {
          capturado.update = payload;
          return { eq: (_c: string, id: string) => { capturado.updateTodoId = id; return Promise.resolve({ error: null }); } };
        },
        insert(row: Record<string, unknown>) {
          if (tabela === "card_events") capturado.evento = row;
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  // deno-lint-ignore no-explicit-any
  return { supabase: supabase as any, capturado };
}

function todoEmail(id: string, codigo: number, template: string) {
  return {
    id,
    status: "pendente",
    proposta_payload: {
      tool: "lancar_oc_e_enviar_email",
      acao_key: `lancar_oc_e_enviar_email:${codigo}`,
      args: { codigo_ssw: codigo, template_id: template, nf: "1100040" },
      meta: { modo: "completo" },
    },
  };
}

Deno.test("4 OPÇÕES: com 54+email E 59+email coexistindo, repatch mira SÓ o trilho destacado (59)", async () => {
  const { supabase, capturado } = mockSupabase();
  const mudou = await repatcharTemplateEmail54Existente(supabase, {
    cardId: "card-1",
    existingTodos: [todoEmail("t54", 54, "FALTA_DE_VOLUME"), todoEmail("t59", 59, "EXTRAVIO_PARCIAL")],
    override: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
    actorId: "teste",
    codigoAlvo: 59,
  });
  assertEquals(mudou, true);
  assertEquals(capturado.updateTodoId, "t59"); // NUNCA o t54
  const pp = capturado.update!["proposta_payload"] as Record<string, unknown>;
  const args = pp["args"] as Record<string, unknown>;
  assertEquals(args["codigo_ssw"], 59);
  assertEquals(pp["acao_key"], "lancar_oc_e_enviar_email:59");
  assertEquals(args["template_id"], "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO");
});

Deno.test("ANTI-REGRESSÃO NF 1100040: destaque 59 com só o 54+email existente → NO-OP (nunca converte; proporAutoAcao cria o 59)", async () => {
  const { supabase, capturado } = mockSupabase();
  const mudou = await repatcharTemplateEmail54Existente(supabase, {
    cardId: "card-1",
    existingTodos: [todoEmail("t54", 54, "EXTRAVIO_PARCIAL")],
    override: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
    actorId: "teste",
    codigoAlvo: 59,
  });
  assertEquals(mudou, false);
  assertEquals(capturado.update, undefined); // o 54+email fica INTOCADO
});

Deno.test("trilho 54: troca só o template do 54; idempotente quando já está no override", async () => {
  const { supabase, capturado } = mockSupabase();
  const mudou = await repatcharTemplateEmail54Existente(supabase, {
    cardId: "card-1",
    existingTodos: [todoEmail("t54", 54, "FALTA_DE_VOLUME")],
    override: "EXTRAVIO_PARCIAL",
    actorId: "teste",
    codigoAlvo: 54,
  });
  assertEquals(mudou, true);
  const args = (capturado.update!["proposta_payload"] as Record<string, unknown>)["args"] as Record<string, unknown>;
  assertEquals(args["codigo_ssw"], 54);
  assertEquals(args["template_id"], "EXTRAVIO_PARCIAL");

  const rodada2 = await repatcharTemplateEmail54Existente(supabase, {
    cardId: "card-1",
    existingTodos: [todoEmail("t54", 54, "EXTRAVIO_PARCIAL")],
    override: "EXTRAVIO_PARCIAL",
    actorId: "teste",
    codigoAlvo: 54,
  });
  assertEquals(rodada2, false);
});
