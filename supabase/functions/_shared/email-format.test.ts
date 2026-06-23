// Guard: formato de e-mail. Âncora NF 45156 (nfe@vipshowroom.com.b truncado).
// Rodar: deno test supabase/functions/_shared/email-format.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isEmailFormatoValido } from "./email-format.ts";

Deno.test("rejeita TLD truncado .com.b (caso NF 45156)", () => {
  assertEquals(isEmailFormatoValido("nfe@vipshowroom.com.b"), false);
  assertEquals(isEmailFormatoValido("aressa.pires@brbrand.com.b"), false);
});

Deno.test("aceita .com.br válido", () => {
  assert(isEmailFormatoValido("nfe@vipshowroom.com.br"));
  assert(isEmailFormatoValido("contato@empresa.com.br"));
  assert(isEmailFormatoValido("user@sub.dominio.com"));
});

Deno.test("rejeita lixo / vazio / sem TLD / sem @", () => {
  for (const x of ["", "   ", null, undefined, "semarroba.com", "user@host", "user@@x.com", "user @x.com", "user@x."]) {
    assertEquals(isEmailFormatoValido(x as string), false, `deveria rejeitar: ${JSON.stringify(x)}`);
  }
});

Deno.test("trim antes de validar", () => {
  assert(isEmailFormatoValido("  nfe@vipshowroom.com.br  "));
});
