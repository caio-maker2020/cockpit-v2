// Guard do parser forense de bounce (Caio 2026-07-01, investigação A).
// Rodar: deno test supabase/functions/_shared/bounce-forensics.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseBounceForensics } from "./bounce-forensics.ts";

// NDR estilo Microsoft/Exchange: multipart/report com text/plain (admin diag),
// message/delivery-status e message/rfc822 (original com DKIM + Authentication-
// Results mostrando dmarc=fail). CRLF reais.
const CRLF = "\r\n";
function eml(lines: string[]): string {
  return lines.join(CRLF);
}

const NDR_EXCHANGE = eml([
  "From: postmaster@hdlhospitalar.com.br",
  "Return-Path: <>",
  "Received: from mx.hdlhospitalar.com.br by mail.salexpress.com.br; Tue, 16 Jun 2026 13:42:00 -0300",
  "Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=hdlhospitalar.com.br",
  "Subject: Undeliverable: Sua mensagem",
  "Message-ID: <ndr-abc@hdlhospitalar.com.br>",
  'Content-Type: multipart/report; report-type=delivery-status; boundary="BND"',
  "MIME-Version: 1.0",
  "",
  "--BND",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Diagnostic information for administrators:",
  "Generating server: mail.hdlhospitalar.com.br",
  "Remote server returned 550 5.7.1 message blocked: DMARC check failed (p=reject).",
  "",
  "--BND",
  "Content-Type: message/delivery-status",
  "",
  "Reporting-MTA: dns; mail.hdlhospitalar.com.br",
  "",
  "Final-Recipient: rfc822; allan.acacio@hdlhospitalar.com.br",
  "Action: failed",
  "Status: 5.7.1",
  "Remote-MTA: dns; mx.hdlhospitalar.com.br",
  "Diagnostic-Code: smtp; 550 5.7.1 message blocked due to DMARC policy (p=reject)",
  "",
  "--BND",
  "Content-Type: message/rfc822",
  "",
  "From: larissa@salexpress.com.br",
  "To: allan.acacio@hdlhospitalar.com.br",
  "Subject: Tratativa NF 575330",
  "Message-ID: <cockpit-xyz@salexpress.com.br>",
  "DKIM-Signature: v=1; a=rsa-sha256; d=salexpress.com.br; s=google; bh=abc; b=def",
  "Authentication-Results: mx.hdlhospitalar.com.br; spf=softfail smtp.mailfrom=salexpress.com.br; dkim=fail; dmarc=fail",
  "",
  "Prezado, segue tratativa...",
  "--BND--",
  "",
]);

Deno.test("forense Exchange: headers do bounce", () => {
  const f = parseBounceForensics(NDR_EXCHANGE);
  assertEquals(f.bounce_headers.from, "postmaster@hdlhospitalar.com.br");
  assertEquals(f.bounce_headers.return_path, "<>");
  assertEquals(f.bounce_headers.subject, "Undeliverable: Sua mensagem");
  assertEquals(f.bounce_headers.message_id, "<ndr-abc@hdlhospitalar.com.br>");
  assertEquals(f.bounce_headers.received.length, 1);
  // AR do bounce é o hop mailer-daemon→nós — NÃO usar pra cravar causa.
  assertEquals(f.bounce_headers.authentication_results.length, 1);
});

Deno.test("forense Exchange: message/delivery-status completo", () => {
  const f = parseBounceForensics(NDR_EXCHANGE);
  assertEquals(f.delivery_status?.reporting_mta, "dns; mail.hdlhospitalar.com.br");
  assertEquals(f.delivery_status?.remote_mta, "dns; mx.hdlhospitalar.com.br");
  assertEquals(f.delivery_status?.final_recipient, "allan.acacio@hdlhospitalar.com.br");
  assertEquals(f.delivery_status?.action, "failed");
  assertEquals(f.delivery_status?.status, "5.7.1");
  assertEquals(
    f.delivery_status?.diagnostic_code,
    "smtp; 550 5.7.1 message blocked due to DMARC policy (p=reject)",
  );
});

Deno.test("forense Exchange: headers do ORIGINAL anexado (aqui é que se crava A)", () => {
  const f = parseBounceForensics(NDR_EXCHANGE);
  assertEquals(f.original?.from, "larissa@salexpress.com.br");
  assertEquals(f.original?.to, "allan.acacio@hdlhospitalar.com.br");
  assertEquals(f.original?.message_id, "<cockpit-xyz@salexpress.com.br>");
  assertEquals(f.original?.dkim_signature?.startsWith("v=1; a=rsa-sha256"), true);
  assertEquals(f.original?.authentication_results.length, 1);
});

Deno.test("forense Exchange: sinais assistidos (não cravam sozinhos)", () => {
  const f = parseBounceForensics(NDR_EXCHANGE);
  assertEquals(f.sinais.dkim_no_original, true);
  assertEquals(f.sinais.spf_no_original, "spf=softfail");
  assertEquals(f.sinais.diagnostic_menciona_auth, true); // "dmarc"/"blocked" no diag
  assertEquals(f.sinais.palavras_auth_encontradas.includes("dmarc"), true);
  assertEquals(f.sinais.aviso.length > 0, true);
});

Deno.test("forense Exchange: texto admin (diagnostic information for administrators)", () => {
  const f = parseBounceForensics(NDR_EXCHANGE);
  assertEquals(
    (f.diagnostic_admin_texto ?? "").includes("Diagnostic information for administrators"),
    true,
  );
  // NÃO deve incluir o corpo do original ("Prezado, segue tratativa").
  assertEquals((f.diagnostic_admin_texto ?? "").includes("Prezado, segue"), false);
});

// NDR simples estilo Google (sem message/rfc822): sem original → sinais neutros.
const NDR_GOOGLE = eml([
  "From: mailer-daemon@googlemail.com",
  "Subject: Delivery Status Notification (Failure)",
  "Message-ID: <g-1@mail.gmail.com>",
  'Content-Type: multipart/report; report-type=delivery-status; boundary="GG"',
  "",
  "--GG",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "Your message to sac@mixmoto.com.br was blocked.",
  '550 "The mail server detected your message as spam and has prevented delivery."',
  "",
  "--GG",
  "Content-Type: message/delivery-status",
  "",
  "Final-Recipient: rfc822; sac@mixmoto.com.br",
  "Action: failed",
  "Status: 5.7.1",
  'Diagnostic-Code: smtp; 550 detected as spam and has prevented delivery',
  "",
  "--GG--",
  "",
]);

Deno.test("forense Google: sem original anexado → original null, sinais neutros", () => {
  const f = parseBounceForensics(NDR_GOOGLE);
  assertEquals(f.original, null);
  assertEquals(f.sinais.dkim_no_original, false);
  assertEquals(f.sinais.spf_no_original, null);
  assertEquals(f.delivery_status?.final_recipient, "sac@mixmoto.com.br");
  // spam block NÃO é falha de auth → diagnostic_menciona_auth deve ser FALSE
  // (exatamente o cuidado do Caio: não inferir SPF/DKIM de um bloqueio de spam).
  assertEquals(f.sinais.diagnostic_menciona_auth, false);
});
