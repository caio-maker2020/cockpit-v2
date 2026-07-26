// Guard do fix onda1 (25/07): relançamento pós-resposta NUNCA é "oc lançada
// por fora". Rodar: deno test supabase/functions/_shared/todo-relancamento.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ehPropostaPosRespostaMesmaOc } from "./todo-relancamento.ts";

Deno.test("ÂNCORA: relancamento_54 do vinculador pós-resposta é isento do auto-cancel", () => {
  assertEquals(
    ehPropostaPosRespostaMesmaOc({
      args: { codigo_ssw: 54 },
      meta: { tipo_acao: "relancamento_54", origem: "vinculador_pos_resposta_cliente" },
    }),
    true,
  );
});

Deno.test("origem pós-resposta sozinha (oc33 solo etc.) também é isenta", () => {
  assertEquals(
    ehPropostaPosRespostaMesmaOc({ meta: { origem: "vinculador_pos_resposta_cliente", tipo_acao: "oc33_solo" } }),
    true,
  );
});

Deno.test("proposta comum do menu (sem origem pós-resposta) NÃO é isenta — auto-cancel legítimo continua", () => {
  assertEquals(ehPropostaPosRespostaMesmaOc({ args: { codigo_ssw: 54 }, meta: { modo: "sem_email" } }), false);
  assertEquals(ehPropostaPosRespostaMesmaOc({ args: { codigo_ssw: 54 } }), false);
  assertEquals(ehPropostaPosRespostaMesmaOc(null), false);
});
