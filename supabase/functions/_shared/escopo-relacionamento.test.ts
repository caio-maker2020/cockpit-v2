// Testes da função pura cardEmEscopoProtegido (invariante "não sai sozinho").
// Rodar: deno test supabase/functions/_shared/escopo-relacionamento.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cardEmEscopoProtegido,
  STATES_PROTEGIDOS_CONFLITO,
} from "./escopo-relacionamento.ts";

Deno.test("AGUARDANDO_VALIDACAO_HUMANA (AGUARDANDO VOCÊ) → protegido", () => {
  assertEquals(cardEmEscopoProtegido("AGUARDANDO_VALIDACAO_HUMANA"), true);
});

Deno.test("AGUARDANDO_CLIENTE (oc=54) → protegido", () => {
  assertEquals(cardEmEscopoProtegido("AGUARDANDO_CLIENTE"), true);
});

Deno.test("AGUARDANDO_AGENTE (PARA FAZER) → NÃO protegido (sai natural)", () => {
  assertEquals(cardEmEscopoProtegido("AGUARDANDO_AGENTE"), false);
});

Deno.test("estados terminais/transientes/null → NÃO protegido", () => {
  assertEquals(cardEmEscopoProtegido("TRANSFERIDO"), false);
  assertEquals(cardEmEscopoProtegido("RESOLVIDO"), false);
  assertEquals(cardEmEscopoProtegido("ACAO_EXECUTADA"), false);
  assertEquals(cardEmEscopoProtegido("EXTRAVIO_MONITORADO"), false);
  assertEquals(cardEmEscopoProtegido(null), false);
  assertEquals(cardEmEscopoProtegido(undefined), false);
});

Deno.test("escopo protegido tem exatamente 2 estados (AGUARDANDO_AGENTE fora)", () => {
  assertEquals(STATES_PROTEGIDOS_CONFLITO.size, 2);
  assertEquals(STATES_PROTEGIDOS_CONFLITO.has("AGUARDANDO_AGENTE"), false);
});
