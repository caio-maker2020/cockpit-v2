// Guard INV-082: reply não empilha prefixo de assunto + Thread-Index ecoado.
// Âncora: NFs 1597524 (Sonepar/Nortel), 58203/55482 (J.A.) — Cockpit mandava
// "Re: RES: X" e o Outlook do cliente abria CONVERSA NOVA a cada resposta
// (Caio 2026-08-18). Gmail agrupa por References e mascarava o problema.
// Rodar: deno test supabase/functions/_shared/email-threading.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extrairThreadIndex,
  garantirPrefixoReply,
  montaReferences,
  temPrefixoReplyOuForward,
  withAngleBrackets,
} from "./email-threading.ts";

Deno.test("RES: do Outlook PT-BR é prefixo de reply — assunto fica intacto (NF 1597524)", () => {
  const s = "RES: Recusa Total — NF 1597524 — NORTEL SUPRIMEN A1";
  assertEquals(garantirPrefixoReply(s), s);
});

Deno.test("assunto sem prefixo ganha 'Re: ' (comportamento original preservado)", () => {
  assertEquals(
    garantirPrefixoReply("Avaria Parcial — NF 58203 — J.A AGRO UBE"),
    "Re: Avaria Parcial — NF 58203 — J.A AGRO UBE",
  );
});

Deno.test("'Re:' existente não duplica (comportamento original preservado)", () => {
  assertEquals(garantirPrefixoReply("Re: Sua tratativa"), "Re: Sua tratativa");
  assertEquals(garantirPrefixoReply("re: sua tratativa"), "re: sua tratativa");
});

Deno.test("prefixos localizados e de forward são reconhecidos", () => {
  for (const s of [
    "RE: Pedido 123",
    "ENC: Nota fiscal em anexo",
    "FW: Comprovante",
    "FWD: Comprovante",
    "RV: Consulta", // es
    "AW: Anfrage", // de
    "RE[2]: Pedido 123", // variante numerada
    "Re: RES: Recusa Total — NF 1597524", // já empilhado (legado) — não piora
  ]) {
    assertEquals(garantirPrefixoReply(s), s, `deveria manter intacto: ${s}`);
    assertEquals(temPrefixoReplyOuForward(s), true, `deveria reconhecer prefixo: ${s}`);
  }
});

Deno.test("palavra que só COMEÇA com prefixo não é prefixo (Recusa/Resumo/Envio)", () => {
  for (const s of ["Recusa Total — NF 999", "Resumo do pedido", "Envio de romaneio", "Reserva confirmada"]) {
    assertEquals(temPrefixoReplyOuForward(s), false, `não é prefixo: ${s}`);
    assertEquals(garantirPrefixoReply(s), `Re: ${s}`);
  }
});

Deno.test("assunto vazio degrada pro fallback", () => {
  assertEquals(garantirPrefixoReply(""), "Re: Sua mensagem");
  assertEquals(garantirPrefixoReply("   "), "Re: Sua mensagem");
});

Deno.test("extrairThreadIndex: chave direta do gmail-poll", () => {
  assertEquals(
    extrairThreadIndex({ thread_index: "AdT3k2xYz+abc==", subject: "x" }),
    "AdT3k2xYz+abc==",
  );
  assertEquals(extrairThreadIndex({ thread_index: "  " }), null);
  assertEquals(extrairThreadIndex({ subject: "sem header" }), null);
});

Deno.test("extrairThreadIndex: array Headers do Postmark (retroativo do ingestor)", () => {
  const raw = {
    Headers: [
      { Name: "X-Spam-Status", Value: "No" },
      { Name: "Thread-Index", Value: "AdT3k2xYz+postmark==" },
    ],
  };
  assertEquals(extrairThreadIndex(raw), "AdT3k2xYz+postmark==");
  assertEquals(extrairThreadIndex({ Headers: [{ Name: "Other", Value: "x" }] }), null);
  assertEquals(extrairThreadIndex({ Headers: "não é array" }), null);
});

Deno.test("helpers RFC 2822 continuam estáveis (regressão)", () => {
  assertEquals(withAngleBrackets("abc@host"), "<abc@host>");
  assertEquals(withAngleBrackets("<abc@host>"), "<abc@host>");
  assertEquals(montaReferences("<a@h>", "<b@h>"), "<a@h> <b@h>");
  assertEquals(montaReferences(null, "<b@h>"), "<b@h>");
});
