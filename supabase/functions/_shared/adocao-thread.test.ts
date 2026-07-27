// Guard do incidente 26/07 (15.052 jobs / 59 cards; NF 166229 re-importada 105x).
// Rodar: deno test supabase/functions/_shared/adocao-thread.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decidirAdocaoThread } from "./adocao-thread.ts";

const THREAD = "19f5b73280a782be";

Deno.test("ÂNCORA 26/07: job repetido da MESMA thread já adotada → pula (não re-importa)", () => {
  const d = decidirAdocaoThread(
    { state: "AGUARDANDO_CLIENTE", tratativa_email_escolhida: THREAD },
    THREAD,
  );
  assertEquals(d.acao, "pular");
});

Deno.test("primeira adoção (card sem tratativa) → adota", () => {
  assertEquals(
    decidirAdocaoThread({ state: "AGUARDANDO_CLIENTE", tratativa_email_escolhida: null }, THREAD).acao,
    "adotar",
  );
});

Deno.test("thread DIFERENTE da adotada → adota (operador pode trocar a tratativa)", () => {
  assertEquals(
    decidirAdocaoThread({ state: "AGUARDANDO_CLIENTE", tratativa_email_escolhida: "outra-thread" }, THREAD).acao,
    "adotar",
  );
});

Deno.test("card terminal → pula (NF 2549: TRANSFERIDO re-importado 44x)", () => {
  for (const st of ["TRANSFERIDO", "RESOLVIDO", "CANCELADO"]) {
    assertEquals(decidirAdocaoThread({ state: st, tratativa_email_escolhida: null }, THREAD).acao, "pular");
  }
});

Deno.test("card inexistente ou job sem thread → pula (nunca explode)", () => {
  assertEquals(decidirAdocaoThread(null, THREAD).acao, "pular");
  assertEquals(decidirAdocaoThread({ state: "AGUARDANDO_CLIENTE" }, null).acao, "pular");
});
