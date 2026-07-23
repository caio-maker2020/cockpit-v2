// Guard INV-047 (parte repatch) — NF 1100040 (LARISSA, 2026-07-23): re-análise
// que muda o TRILHO (54↔59) converte o todo clicável inteiro (codigo_ssw +
// acao_key + template), não só o template — senão o destaque do banner aponta
// pra um todo que não existe ("ação não está mais pendente").
// Rodar: deno test --allow-env supabase/functions/_shared/repatch-trilho.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { repatcharTemplateEmail54Existente } from "./regras-auto-acao.ts";

// Mock mínimo: captura o UPDATE de todos e o INSERT de card_events.
function mockSupabase() {
  const capturado: { update?: Record<string, unknown>; evento?: Record<string, unknown> } = {};
  const supabase = {
    from(tabela: string) {
      return {
        update(payload: Record<string, unknown>) {
          capturado.update = payload;
          return { eq: () => Promise.resolve({ error: null }) };
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

function todo54Email(template: string) {
  return {
    id: "todo-1",
    status: "pendente",
    proposta_payload: {
      tool: "lancar_oc_e_enviar_email",
      acao_key: "lancar_oc_e_enviar_email:54",
      descricao: "Lançar oc 54 + email",
      args: { codigo_ssw: 54, template_id: template, nf: "1100040" },
      meta: { modo: "completo" },
    },
  };
}

Deno.test("ÂNCORA NF 1100040: destaque muda pra 59 → converte codigo_ssw + acao_key + template", async () => {
  const { supabase, capturado } = mockSupabase();
  const mudou = await repatcharTemplateEmail54Existente(supabase, {
    cardId: "card-1",
    existingTodos: [todo54Email("EXTRAVIO_PARCIAL")],
    override: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
    actorId: "teste",
    codigoAlvo: 59,
  });
  assertEquals(mudou, true);
  const pp = capturado.update!["proposta_payload"] as Record<string, unknown>;
  const args = pp["args"] as Record<string, unknown>;
  assertEquals(args["codigo_ssw"], 59);
  assertEquals(pp["acao_key"], "lancar_oc_e_enviar_email:59");
  assertEquals(args["template_id"], "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO");
  // preserva o resto
  assertEquals(args["nf"], "1100040");
  assertEquals((pp["meta"] as Record<string, unknown>)["modo"], "completo");
  const evPayload = (capturado.evento!["payload"]) as Record<string, unknown>;
  assertEquals(evPayload["trilho_convertido"], true);
  assertEquals(evPayload["codigo_para"], 59);
});

Deno.test("mesmo trilho + mesmo template → no-op idempotente (sem UPDATE, sem evento)", async () => {
  const { supabase, capturado } = mockSupabase();
  const mudou = await repatcharTemplateEmail54Existente(supabase, {
    cardId: "card-1",
    existingTodos: [todo54Email("EXTRAVIO_PARCIAL")],
    override: "EXTRAVIO_PARCIAL",
    actorId: "teste",
    codigoAlvo: 54,
  });
  assertEquals(mudou, false);
  assertEquals(capturado.update, undefined);
});

Deno.test("mesmo trilho, template diferente → troca SÓ o template (comportamento histórico preservado)", async () => {
  const { supabase, capturado } = mockSupabase();
  const mudou = await repatcharTemplateEmail54Existente(supabase, {
    cardId: "card-1",
    existingTodos: [todo54Email("FALTA_DE_VOLUME")],
    override: "EXTRAVIO_PARCIAL",
    actorId: "teste",
    codigoAlvo: 54,
  });
  assertEquals(mudou, true);
  const pp = capturado.update!["proposta_payload"] as Record<string, unknown>;
  const args = pp["args"] as Record<string, unknown>;
  assertEquals(args["codigo_ssw"], 54);
  assertEquals(pp["acao_key"], "lancar_oc_e_enviar_email:54");
  assertEquals(args["template_id"], "EXTRAVIO_PARCIAL");
});
