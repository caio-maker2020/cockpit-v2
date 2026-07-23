// deno test supabase/functions/_shared/sugestao-texto-registro.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  montarRegistroSugestaoTexto,
  salvarSugestaoTexto,
} from "./sugestao-texto-registro.ts";

Deno.test("monta registro completo de email_saida com truncamento", () => {
  const r = montarRegistroSugestaoTexto({
    cardId: "c1",
    tipo: "email_saida",
    texto: "  Prezado cliente, ...  ",
    assunto: "A".repeat(600),
    codigoSsw: "54",
    modelo: "claude-sonnet-4-6",
  })!;
  assertEquals(r.card_id, "c1");
  assertEquals(r.codigo_ssw, 54);
  assertEquals(r.texto_sugerido, "Prezado cliente, ...");
  assertEquals((r.assunto_sugerido as string).length, 500);
});

Deno.test("sem card_id ou texto vazio → null (não grava lixo)", () => {
  assertEquals(
    montarRegistroSugestaoTexto({ cardId: null, tipo: "cobranca", texto: "x" }),
    null,
  );
  assertEquals(
    montarRegistroSugestaoTexto({ cardId: "c1", tipo: "cobranca", texto: "   " }),
    null,
  );
});

Deno.test("salvar é best-effort: erro do client NUNCA propaga", async () => {
  const clientQueFalha = {
    from: () => ({
      insert: () => Promise.reject(new Error("db fora")),
    }),
  };
  // não deve lançar
  await salvarSugestaoTexto(clientQueFalha, {
    cardId: "c1",
    tipo: "cobranca",
    texto: "oi",
    papel: "gerente_base",
    canal: "email",
  });
});
