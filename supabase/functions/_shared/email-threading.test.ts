// Guard INV-084: reply não empilha prefixo de assunto + Thread-Index ecoado.
// Âncora: NFs 1597524 (Sonepar/Nortel), 58203/55482 (J.A.) — Cockpit mandava
// "Re: RES: X" e o Outlook do cliente abria CONVERSA NOVA a cada resposta
// (Caio 2026-08-18). Gmail agrupa por References e mascarava o problema.
// Rodar: deno test supabase/functions/_shared/email-threading.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  escolherAncoraThread,
  extrairThreadIndex,
  garantirPrefixoReply,
  montaReferences,
  normalizeReferencesHeader,
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

// ---------------------------------------------------------------------------
// Extensão Carlos 2026-09-09 — assunto byte-a-byte + Message-ID fantasma nunca
// vira âncora. Âncoras: NF 7481 (BIOMEDICAL), NF 683869 (WURTH), NF 51340.
// ---------------------------------------------------------------------------

Deno.test("assunto com espaço na frente NÃO é trimado (NF 7481 BIOMEDICAL)", () => {
  // Cliente mandou " Recusa Total..." (espaço inicial). Outlook responde
  // "RE:  Recusa Total" — nós também: prefixo + assunto intacto.
  assertEquals(
    garantirPrefixoReply(" Recusa Total — NF 7481 — EMBECTA  DISTRIB. DE MED. STA CRUZ LTDA"),
    "Re:  Recusa Total — NF 7481 — EMBECTA  DISTRIB. DE MED. STA CRUZ LTDA",
  );
  // Com prefixo já presente, espaços (inclusive finais e duplos) ficam como estão.
  assertEquals(garantirPrefixoReply("RES:  Recusa Total — NF 7481 "), "RES:  Recusa Total — NF 7481 ");
  assertEquals(
    garantirPrefixoReply("RES: Rastreamento de carga de F E F- Nota Fiscal 1   783759."),
    "RES: Rastreamento de carga de F E F- Nota Fiscal 1   783759.",
  );
});

Deno.test("Message-ID fantasma (cockpit-...) NUNCA vira header", () => {
  assertEquals(withAngleBrackets("cockpit-31b1e068-294e-4d0b-a411-97ad270740cb@salexpress.com.br"), null);
  assertEquals(withAngleBrackets("<cockpit-abc@salexpress.com.br>"), null);
  // Cadeia com fantasma no meio: só os reais sobrevivem.
  assertEquals(
    normalizeReferencesHeader("<cockpit-x@s.br> CA+uANJZ@mail.gmail.com <PAXPR10MB4930E143@outlook.com>"),
    "<CA+uANJZ@mail.gmail.com> <PAXPR10MB4930E143@outlook.com>",
  );
  assertEquals(normalizeReferencesHeader("<cockpit-x@s.br>"), null);
  // Real continua real.
  assertEquals(withAngleBrackets("CA+uANJZuzEK4Uhs@mail.gmail.com"), "<CA+uANJZuzEK4Uhs@mail.gmail.com>");
});

const INB = {
  message_id_header: "PAXPR10MB4930E143@PAXPR10MB4930.EURPRD10.PROD.OUTLOOK.COM",
  references_header: "<CADqfTnHP52@mail.gmail.com>",
  raw_payload: { subject: "RES: Insucesso na entrega — NF 683869 — WURTH", thread_index: "AQHdL93fwzKyHqJGQUqxN3F1uy6qQL" },
  recebido_em: "2026-08-20T14:26:00Z",
};

Deno.test("âncora: outbound mais recente com id FANTASMA → ancora no inbound do cliente (WURTH NF 683869)", () => {
  const a = escolherAncoraThread({
    outbound: { message_id_header: "cockpit-1903b347@salexpress.com.br", subject: "Insucesso na entrega — NF 683869 — WURTH", sent_at: "2026-08-28T20:05:00Z" },
    inbound: INB,
  });
  assertEquals(a.in_reply_to, "<PAXPR10MB4930E143@PAXPR10MB4930.EURPRD10.PROD.OUTLOOK.COM>");
  assertEquals(a.references, "<CADqfTnHP52@mail.gmail.com> <PAXPR10MB4930E143@PAXPR10MB4930.EURPRD10.PROD.OUTLOOK.COM>");
  assertEquals(a.thread_index, "AQHdL93fwzKyHqJGQUqxN3F1uy6qQL");
  // Assunto da mensagem mais recente (nosso outbound) — o que já está na conversa.
  assertEquals(a.subject_original, "Insucesso na entrega — NF 683869 — WURTH");
});

Deno.test("âncora: outbound mais recente com id REAL → ancora nele, cadeia inbound + nosso id", () => {
  const a = escolherAncoraThread({
    outbound: { message_id_header: "CAPEdBL2ruu@mail.gmail.com", subject: "RES: Insucesso na entrega — NF 683869 — WURTH", sent_at: "2026-08-28T20:05:00Z" },
    inbound: INB,
  });
  assertEquals(a.in_reply_to, "<CAPEdBL2ruu@mail.gmail.com>");
  assertEquals(
    a.references,
    "<CADqfTnHP52@mail.gmail.com> <PAXPR10MB4930E143@PAXPR10MB4930.EURPRD10.PROD.OUTLOOK.COM> <CAPEdBL2ruu@mail.gmail.com>",
  );
  assertEquals(a.thread_index, "AQHdL93fwzKyHqJGQUqxN3F1uy6qQL");
});

Deno.test("âncora: inbound mais recente → ancora no cliente mesmo com outbound real antigo", () => {
  const a = escolherAncoraThread({
    outbound: { message_id_header: "CAPEdBL2ruu@mail.gmail.com", subject: "Insucesso — NF 1", sent_at: "2026-08-19T13:23:00Z" },
    inbound: INB,
  });
  assertEquals(a.in_reply_to, "<PAXPR10MB4930E143@PAXPR10MB4930.EURPRD10.PROD.OUTLOOK.COM>");
  assertEquals(a.subject_original, "RES: Insucesso na entrega — NF 683869 — WURTH");
});

Deno.test("âncora: só outbound fantasma, sem inbound → sem In-Reply-To (nunca aponta pro nada)", () => {
  const a = escolherAncoraThread({
    outbound: { message_id_header: "cockpit-x@salexpress.com.br", subject: "Insucesso — NF 2", sent_at: "2026-08-28T20:05:00Z" },
    inbound: null,
  });
  assertEquals(a.in_reply_to, null);
  assertEquals(a.references, null);
  assertEquals(a.thread_index, null);
  assertEquals(a.subject_original, "Insucesso — NF 2");
});

Deno.test("âncora: só outbound real, sem inbound → ancora nele (2º e-mail proativo encadeia)", () => {
  const a = escolherAncoraThread({
    outbound: { message_id_header: "CAPEdBL9@mail.gmail.com", subject: "Insucesso — NF 3", sent_at: "2026-08-28T20:05:00Z" },
    inbound: null,
  });
  assertEquals(a.in_reply_to, "<CAPEdBL9@mail.gmail.com>");
  assertEquals(a.references, "<CAPEdBL9@mail.gmail.com>");
});

// --- Carlos 2026-09-10 (achado da validação pré-merge) --------------------
// O ramo "inbound mais recente porém SEM id real" jogava fora o Message-ID
// REAL do nosso outbound e devolvia in_reply_to=null. São 22 de 20.007
// inbounds com message_id_header nulo (medido em 09/09), e neles a nossa
// mensagem é a ÚNICA âncora existente.
Deno.test("âncora: inbound mais recente SEM id real → recua pro outbound real (não perde a âncora)", () => {
  const a = escolherAncoraThread({
    outbound: {
      message_id_header: "CADqfTnHP52ux@mail.gmail.com",
      subject: "Insucesso na entrega — NF 684248",
      sent_at: "2026-09-01T10:00:00Z",
    },
    inbound: {
      message_id_header: null, // inbound sem Message-ID capturado
      references_header: null,
      raw_payload: { subject: "RES: Insucesso na entrega — NF 684248", thread_index: "AQHb9k1t" },
      recebido_em: "2026-09-02T11:00:00Z", // MAIS RECENTE que o outbound
    },
  });
  assertEquals(a.in_reply_to, "<CADqfTnHP52ux@mail.gmail.com>");
  assertEquals(a.references, "<CADqfTnHP52ux@mail.gmail.com>");
  // Thread-Index e assunto continuam vindo do inbound (tópico do cliente).
  assertEquals(a.thread_index, "AQHb9k1t");
  assertEquals(a.subject_original, "RES: Insucesso na entrega — NF 684248");
});

Deno.test("âncora: inbound mais recente com id FANTASMA → recua pro outbound real", () => {
  const a = escolherAncoraThread({
    outbound: {
      message_id_header: "CADqfTnHP52ux@mail.gmail.com",
      subject: "Insucesso — NF 5",
      sent_at: "2026-09-01T10:00:00Z",
    },
    inbound: {
      message_id_header: "cockpit-deadbeef@salexpress.com.br",
      references_header: null,
      raw_payload: { subject: "RES: Insucesso — NF 5" },
      recebido_em: "2026-09-02T11:00:00Z",
    },
  });
  assertEquals(a.in_reply_to, "<CADqfTnHP52ux@mail.gmail.com>");
});
