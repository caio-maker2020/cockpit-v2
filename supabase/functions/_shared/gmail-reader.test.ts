// Guard: extrairTexto limpa HTML cru no corpo (NF 119350, ~131 e-mails Exchange,
// Duílio 2026-07-31) mas NÃO mexe em text/plain.
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extrairTexto, type GmailMessageFull } from "./gmail-reader.ts";

// base64url de string ASCII
function b64(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function msg(payload: GmailMessageFull["payload"], snippet = ""): GmailMessageFull {
  return { id: "1", threadId: "1", snippet, payload };
}

Deno.test("single-part text/html (Exchange) → HTML é limpo, sem tags", () => {
  const html = '<html><head><meta charset="Windows-1252"></head><body><p>Segue a NF 119350 em anexo.</p></body></html>';
  const out = extrairTexto(msg({ mimeType: "text/html", body: { data: b64(html) } }));
  assertEquals(out.includes("<"), false);
  assertEquals(out.includes("meta"), false);
  assertStringIncludes(out, "Segue a NF 119350 em anexo.");
});

Deno.test("single-part text/plain → intacto (não colapsa nada relevante)", () => {
  const plain = "Bom dia, autorizo seguir com a entrega.";
  const out = extrairTexto(msg({ mimeType: "text/plain", body: { data: b64(plain) } }));
  assertEquals(out, plain);
});

Deno.test("corpo HTML sem mimeType confiável → detecta por marcação e limpa", () => {
  const html = "<div><br>autorizado seguir</div>";
  const out = extrairTexto(msg({ body: { data: b64(html) } }));
  assertEquals(out.includes("<"), false);
  assertStringIncludes(out, "autorizado seguir");
});

Deno.test("multipart: text/plain tem prioridade e volta intacto", () => {
  const out = extrairTexto(msg({
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64("versao texto plano") } },
      { mimeType: "text/html", body: { data: b64("<p>versao html</p>") } },
    ],
  }));
  assertEquals(out, "versao texto plano");
});

Deno.test("multipart só com text/html → limpa o HTML", () => {
  const out = extrairTexto(msg({
    mimeType: "multipart/alternative",
    parts: [{ mimeType: "text/html", body: { data: b64("<p>so <b>html</b> aqui</p>") } }],
  }));
  assertEquals(out.includes("<"), false);
  assertStringIncludes(out, "so html aqui");
});
