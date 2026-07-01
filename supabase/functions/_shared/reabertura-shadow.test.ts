// Testes PUROS do shadow (PR3). Só os helpers de comparação atual×proposta; o
// insert é side-effect (não testado aqui — sem DB). Rodar:
//   deno test supabase/functions/_shared/reabertura-shadow.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { desfechoDiverge, operadorVe } from "./reabertura-shadow.ts";

Deno.test("operadorVe: MOSTRAR_OPERADOR e 'reabrir' → visível", () => {
  assertEquals(operadorVe("MOSTRAR_OPERADOR"), true);
  assertEquals(operadorVe("reabrir"), true);
});

Deno.test("operadorVe: manter/aguardando/indefinido → NÃO visível", () => {
  assertEquals(operadorVe("MANTER_FORA_RELACIONAMENTO"), false);
  assertEquals(operadorVe("AGUARDANDO_CLIENTE"), false);
  assertEquals(operadorVe("INDEFINIDO_RETRY"), false);
  assertEquals(operadorVe("suprimir"), false);
  assertEquals(operadorVe("indefinido"), false);
});

Deno.test("desfechoDiverge: caso 346896 (atual suprimir × proposta MOSTRAR) → DIVERGE", () => {
  assertEquals(desfechoDiverge("suprimir", "MOSTRAR_OPERADOR"), true);
});

Deno.test("desfechoDiverge: ambos visíveis (reabrir × MOSTRAR) → não diverge", () => {
  assertEquals(desfechoDiverge("reabrir", "MOSTRAR_OPERADOR"), false);
});

Deno.test("desfechoDiverge: ambos não-visíveis (suprimir × MANTER_FORA) → não diverge", () => {
  assertEquals(desfechoDiverge("suprimir", "MANTER_FORA_RELACIONAMENTO"), false);
});

Deno.test("desfechoDiverge: BLOQUEADOR potencial (atual suprimir × proposta MOSTRAR) marca divergência p/ revisão", () => {
  // O shadow não distingue 'bom' de 'ruim' — só marca divergência. A query de
  // análise é que separa: divergência boa (terceiro) vs bloqueadora (ai.salex).
  assertEquals(desfechoDiverge("suprimir", "MOSTRAR_OPERADOR"), true);
});

Deno.test("desfechoDiverge: sem decisão atual (null) → não diverge", () => {
  assertEquals(desfechoDiverge(null, "MOSTRAR_OPERADOR"), false);
});

Deno.test("desfechoDiverge: AGUARDANDO_CLIENTE proposta (atual suprimir) → não diverge (ambos fora de AGUARDANDO VOCÊ)", () => {
  assertEquals(desfechoDiverge("suprimir", "AGUARDANDO_CLIENTE"), false);
});
