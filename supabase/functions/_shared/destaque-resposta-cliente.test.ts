// Guard da etapa B do plano de veto (25/08): a ação destacada do interpretador
// é resolvida UMA vez no backend, com a MESMA preferência da heurística do
// front (que vira fallback). Se isto regredir, o trilho autônomo pode agendar
// um todo diferente do que o operador vê destacado — quebra da confiança.
// Rodar: deno test supabase/functions/_shared/destaque-resposta-cliente.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolverAcaoDestacada,
  type TodoPendenteResumo,
} from "./destaque-resposta-cliente.ts";

const todo = (
  id: string,
  tool: string,
  codigo: number,
  meta: Record<string, unknown> = {},
): TodoPendenteResumo => ({
  id,
  proposta_payload: { tool, acao_key: `${tool}:${codigo}`, args: { codigo_ssw: codigo }, meta },
});

Deno.test("NF 1502332: sugeriu a MESMA oc do card (54) → destaque é AGUARDAR, nunca relançar", () => {
  const r = resolverAcaoDestacada(
    { oc_sugerida: 54 },
    54,
    [todo("t1", "lancar_ocorrencia", 54, { tipo_acao: "relancamento_54" })],
  );
  assertEquals(r.tipo, "aguardar");
  assertEquals(r.acao_key, "ignorar_e_aguardar:54");
  assertEquals(r.todo_id, null);
});

Deno.test("trilho indenização: mesma regra vale pra 59 sobre 59", () => {
  const r = resolverAcaoDestacada({ oc_sugerida: 59 }, 59, []);
  assertEquals(r.acao_key, "ignorar_e_aguardar:59");
});

Deno.test("cobrou_antes_notificacao NÃO vira aguardar (cliente criou a conversa)", () => {
  const r = resolverAcaoDestacada(
    { oc_sugerida: 54, contexto: "cobrou_antes_notificacao" },
    54,
    [todo("t1", "lancar_oc_e_enviar_email", 54, { modo: "completo" })],
  );
  assertEquals(r.tipo, "todo");
  assertEquals(r.acao_key, "lancar_oc_e_enviar_email:54");
});

Deno.test("NF 306070: oc 21 pós-resposta casa o todo exato por código (nível 3)", () => {
  const r = resolverAcaoDestacada(
    { oc_sugerida: 21 },
    10,
    [todo("t21", "lancar_ocorrencia", 21), todo("t44", "lancar_ocorrencia", 44)],
  );
  assertEquals(r.tipo, "todo");
  assertEquals(r.acao_key, "lancar_ocorrencia:21");
  assertEquals(r.todo_id, "t21");
  assertEquals(r.nivel, "por_codigo");
});

Deno.test("empate 54 com/sem e-mail: preferir quem NOTIFICA (modo completo)", () => {
  const r = resolverAcaoDestacada(
    { oc_sugerida: 54 },
    49,
    [
      todo("sem", "lancar_ocorrencia", 54, { sem_email_explicito: true }),
      todo("com", "lancar_oc_e_enviar_email", 54, { modo: "completo" }),
    ],
  );
  assertEquals(r.todo_id, "com");
  assertEquals(r.nivel, "tool_codigo");
});

Deno.test("combo oc33 solo (NF 234381, trilho indenização): destaque é o todo do combo", () => {
  const r = resolverAcaoDestacada(
    { oc_sugerida: 33, sugere_oc33_solo: true },
    59,
    [
      todo("solo", "lancar_oc33_solo_portal", 33, { tipo_acao: "oc33_solo" }),
      todo("combo", "lancar_combo_33_44", 33, { tipo_acao: "combo_33_44" }),
    ],
  );
  assertEquals(r.todo_id, "solo");
  assertEquals(r.acao_key, "lancar_oc33_solo_portal:33");
  assertEquals(r.nivel, "acao_exata");
});

Deno.test("combo 44+59: casa por tool OU tipo_acao", () => {
  const soPorTipo: TodoPendenteResumo = {
    id: "c4459",
    proposta_payload: {
      tool: "lancar_combo_44_59",
      args: { codigo_ssw: 59 },
      meta: { tipo_acao: "combo_44_59" },
    },
  };
  const r = resolverAcaoDestacada({ oc_sugerida: 44, sugere_combo_44_59: true }, 54, [soPorTipo]);
  assertEquals(r.todo_id, "c4459");
});

Deno.test("sem sugestão ou sem todo casável → nenhum destaque (front não inventa)", () => {
  assertEquals(resolverAcaoDestacada({}, 54, []).tipo, null);
  assertEquals(
    resolverAcaoDestacada({ oc_sugerida: 21 }, 10, [todo("t44", "lancar_ocorrencia", 44)]).tipo,
    null,
  );
});

Deno.test("acao_tool explícito da IA tem prioridade sobre o default", () => {
  const r = resolverAcaoDestacada(
    { oc_sugerida: 55, acao_tool: "lancar_ocorrencia" },
    11,
    [todo("t55", "lancar_ocorrencia", 55)],
  );
  assertEquals(r.nivel, "tool_codigo");
  assertEquals(r.todo_id, "t55");
});
