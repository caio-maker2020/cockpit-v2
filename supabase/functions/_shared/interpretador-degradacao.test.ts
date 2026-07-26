// INV-055 — guard do incidente 26/07 (NF 164346): card com resposta de cliente
// NUNCA fica sem interpretação, e falha de leitura não vira loop infinito.
// Rodar: deno test supabase/functions/_shared/interpretador-degradacao.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CONFIANCA_MAX_LEITURA_PARCIAL,
  degradarLeituraParcial,
  deveDesistirDoLlm,
  MAX_FALHAS_LLM,
  montarSugestaoDegradada,
  PENDENCIA_LEITURA_FALHOU,
  PENDENCIA_LEITURA_PARCIAL,
} from "./interpretador-degradacao.ts";

Deno.test("deveDesistirDoLlm: só desiste no limite (antes disso ainda tenta)", () => {
  assertEquals(deveDesistirDoLlm(0), false);
  assertEquals(deveDesistirDoLlm(MAX_FALHAS_LLM - 1), false);
  assertEquals(deveDesistirDoLlm(MAX_FALHAS_LLM), true);
  // o caso real: 137 falhas na mesma mensagem jamais poderia acontecer
  assertEquals(deveDesistirDoLlm(137), true);
});

Deno.test("montarSugestaoDegradada: card fica COM sugestão e pendência (nunca vazio)", () => {
  const s = montarSugestaoDegradada(54);
  assertEquals(s.oc_sugerida, 54);
  assertEquals(s.confianca, 0);
  assertEquals(s.pendencias_resposta_cliente, [PENDENCIA_LEITURA_FALHOU]);
  // conservador: nenhuma ação de indenização/devolução por conta própria
  assertEquals(s.sugere_combo_33_44, false);
  assertEquals(s.sugere_oc33_solo, false);
  assertEquals(s.sugere_combo_44_59, false);
});

Deno.test("montarSugestaoDegradada: respeita o trilho de indenização (59 não vira 54)", () => {
  assertEquals(montarSugestaoDegradada(59).oc_sugerida, 59);
  assertEquals(montarSugestaoDegradada(null).oc_sugerida, 54);
  assertEquals(montarSugestaoDegradada(44).oc_sugerida, 54);
});

Deno.test("degradarLeituraParcial: mantém a decisão, corta confiança e avisa", () => {
  const out = degradarLeituraParcial({
    oc_sugerida: 33,
    confianca: 0.82,
    pendencias_resposta_cliente: ["Cliente não reenviou o romaneio"],
  });
  assertEquals(out.oc_sugerida, 33); // decisão preservada
  assertEquals(out.confianca, CONFIANCA_MAX_LEITURA_PARCIAL);
  assertEquals(out.pendencias_resposta_cliente?.[0], PENDENCIA_LEITURA_PARCIAL);
  assertEquals(out.pendencias_resposta_cliente?.length, 2);
});

Deno.test("degradarLeituraParcial: nunca INFLA confiança já baixa", () => {
  assertEquals(degradarLeituraParcial({ confianca: 0.2 }).confianca, 0.2);
});
