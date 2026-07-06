// Guard de não-regressão do bug B (Caio 2026-07-01, NF 575330 HDL LOGISTICA /
// Larissa): banner "EMAIL BLOQUEADO" mostrava blob hex do diagnóstico Exchange
// no lugar da razão SMTP e "destino" no lugar do destinatário, porque a extração
// usava `/(550...)/` sobre o 1º text/plain e ignorava o `message/delivery-status`.
//
// Rodar: deno test supabase/functions/_shared/parse-bounce-ndr.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extrairMotivoSmtpHumano,
  parseBounceNdr,
} from "./parse-bounce-ndr.ts";

// --- NDR Microsoft/Exchange COM message/delivery-status (caso HDL) ------------
Deno.test("Exchange DSN: extrai Final-Recipient + Diagnostic-Code limpos", () => {
  const info = parseBounceNdr([
    { mimeType: "text/plain", text: "Your message couldn't be delivered." },
    {
      mimeType: "message/delivery-status",
      text:
        "Reporting-MTA: dns; mail.hdlhospitalar.com.br\r\n\r\n" +
        "Final-Recipient: rfc822; allan.acacio@hdlhospitalar.com.br\r\n" +
        "Action: failed\r\n" +
        "Status: 5.7.1\r\n" +
        "Diagnostic-Code: smtp; 550 5.7.1 Message rejected as spam by content filter\r\n",
    },
  ]);
  assertEquals(info.fonte, "delivery-status");
  assertEquals(info.destinatario, "allan.acacio@hdlhospitalar.com.br");
  assertEquals(info.motivo_smtp, "550 5.7.1 Message rejected as spam by content filter");
  assertEquals(info.status_code, "5.7.1");
  assertEquals(info.action, "failed");
});

// --- Diagnostic-Code dobrado em várias linhas (continuation) ------------------
Deno.test("Exchange DSN: desdobra Diagnostic-Code multi-linha", () => {
  const info = parseBounceNdr([
    {
      mimeType: "message/delivery-status",
      text:
        "Final-Recipient: rfc822; sac@mixmoto.com.br\r\n" +
        "Action: failed\r\n" +
        "Status: 5.7.606\r\n" +
        "Diagnostic-Code: smtp; 550 5.7.606 Access denied, banned sending IP\r\n" +
        " [1.2.3.4]. To request removal contact postmaster.\r\n",
    },
  ]);
  assertEquals(info.destinatario, "sac@mixmoto.com.br");
  assertEquals(
    info.motivo_smtp,
    "550 5.7.606 Access denied, banned sending IP [1.2.3.4]. To request removal contact postmaster.",
  );
});

// --- NDR simples só texto (caso MIX MOTO original) — segue funcionando --------
Deno.test("bounce só texto humano 550 spam: extrai razão legível", () => {
  const info = parseBounceNdr([
    {
      mimeType: "text/plain",
      text:
        "This is the mail system at host aspmx.l.google.com.\n\n" +
        "The following message to <sac@mixmoto.com.br> was rejected:\n" +
        '550 "The mail server detected your message as spam and has prevented delivery."\n',
    },
  ]);
  assertEquals(info.fonte, "texto");
  assertEquals(info.destinatario, "sac@mixmoto.com.br");
  assertEquals(
    info.motivo_smtp,
    '550 "The mail server detected your message as spam and has prevented delivery."',
  );
});

// --- ANTI-REGRESSÃO: blob hex NÃO vira motivo (bug B) -------------------------
Deno.test("blob hex do Exchange no texto: NÃO exibe garbage, retorna null", () => {
  // "550" aparece DENTRO de um blob hex de diagnóstico (sem delivery-status).
  const hexBlob =
    "5503238344042323531393A616531376631636220336533632034343037206163232620" +
    "376437333334613565626633633A38303738303A2E4E45542031302E302E380000000000";
  const info = parseBounceNdr([
    { mimeType: "text/plain", text: `Diagnostic info: ${hexBlob}\n` },
  ]);
  assertEquals(info.motivo_smtp, null); // melhor null do que hex no banner
  assertEquals(info.fonte, "nenhuma");
});

Deno.test("extrairMotivoSmtpHumano: rejeita blob hex, aceita razão real", () => {
  assertEquals(
    extrairMotivoSmtpHumano("5503238344042323531393A616531376631636220336533"),
    null,
  );
  assertEquals(
    extrairMotivoSmtpHumano("550 5.2.1 The user's mailbox is full"),
    "550 5.2.1 The user's mailbox is full",
  );
});

// --- delivery-status vence texto: mesmo com hex no text/plain, usa o DSN ------
Deno.test("prioriza delivery-status sobre text/plain com hex", () => {
  const info = parseBounceNdr([
    { mimeType: "text/plain", text: "550ABCDEF0123456789diagnostic hex noise" },
    {
      mimeType: "message/delivery-status",
      text:
        "Final-Recipient: rfc822; cliente@exemplo.com.br\r\n" +
        "Status: 5.7.1\r\n" +
        "Diagnostic-Code: smtp; 550 5.7.1 blocked\r\n",
    },
  ]);
  assertEquals(info.fonte, "delivery-status");
  assertEquals(info.destinatario, "cliente@exemplo.com.br");
  assertEquals(info.motivo_smtp, "550 5.7.1 blocked");
});

// --- ANTI-REGRESSÃO (validação Caio): blob hex NO Diagnostic-Code estruturado -
Deno.test("DSN com Diagnostic-Code hex: cai pro Status+Action, NÃO exibe hex", () => {
  const hexBlob =
    "5503238344042323531393A616531376631636220336533632034343037206163232620" +
    "376437333334613565626633633A38303738303A2E4E45542031302E302E38";
  const info = parseBounceNdr([
    {
      mimeType: "message/delivery-status",
      text:
        "Final-Recipient: rfc822; allan.acacio@hdlhospitalar.com.br\r\n" +
        "Action: failed\r\n" +
        "Status: 5.7.1\r\n" +
        `Diagnostic-Code: smtp; ${hexBlob}\r\n`,
    },
  ]);
  assertEquals(info.fonte, "delivery-status");
  assertEquals(info.destinatario, "allan.acacio@hdlhospitalar.com.br");
  assertEquals(info.motivo_smtp, "5.7.1 failed"); // fallback limpo, não o hex
  assertEquals(info.status_code, "5.7.1");
});

// --- código terso "550 5.7.1" no Diagnostic-Code NÃO pode ser rejeitado -------
Deno.test("DSN com Diagnostic-Code só código (sem texto): preserva '550 5.7.1'", () => {
  const info = parseBounceNdr([
    {
      mimeType: "message/delivery-status",
      text:
        "Final-Recipient: rfc822; x@y.com.br\r\n" +
        "Status: 5.7.1\r\n" +
        "Diagnostic-Code: smtp; 550 5.7.1\r\n",
    },
  ]);
  assertEquals(info.motivo_smtp, "550 5.7.1");
});

// --- sem código SMTP e sem DSN: tudo null, banner ainda aparece sem motivo ----
Deno.test("bounce sem razão detectável: campos null, fonte=nenhuma", () => {
  const info = parseBounceNdr([
    { mimeType: "text/plain", text: "Delivery to the following recipient failed permanently." },
  ]);
  assertEquals(info.motivo_smtp, null);
  assertEquals(info.destinatario, null);
  assertEquals(info.fonte, "nenhuma");
});
