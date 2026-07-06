// Guard de não-regressão INV-025 (NF 1486931 CAMILA, 2026-06-25): a assinatura
// da cliente (`image001.jpg`, 138KB image/jpeg) foi capturada como "o anexo da
// cliente" porque passou allowlist de MIME + limite 10MB. Agora classificamos
// `inlineNoCorpo` (Content-Disposition: inline OU Content-ID referenciado via
// `cid:` no HTML) e `selecionarAnexosParaSalvar` ignora inline SÓ quando há
// anexo real coexistindo — sem regredir NF 647384 (foto colada no corpo, sem
// outro anexo, continua sendo salva).
//
// Rodar: deno test supabase/functions/_shared/gmail-anexos-classificacao.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extrairAnexos,
  type GmailMessageFull,
  selecionarAnexosParaSalvar,
} from "./gmail-reader.ts";

// --- builders de payload Gmail ---------------------------------------------

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function htmlPart(html: string) {
  return { mimeType: "text/html", body: { data: b64url(html) } };
}

function attachmentPart(opts: {
  filename: string;
  mimeType: string;
  size: number;
  disposition?: "inline" | "attachment";
  contentId?: string;
}) {
  const headers = [];
  if (opts.disposition) {
    headers.push({
      name: "Content-Disposition",
      value: `${opts.disposition}; filename="${opts.filename}"`,
    });
  }
  if (opts.contentId) {
    headers.push({ name: "Content-ID", value: `<${opts.contentId}>` });
  }
  return {
    partId: "x",
    mimeType: opts.mimeType,
    filename: opts.filename,
    headers,
    body: { attachmentId: `att-${opts.filename}`, size: opts.size },
  };
}

function msg(parts: unknown[]): GmailMessageFull {
  return {
    id: "m1",
    threadId: "t1",
    payload: { mimeType: "multipart/mixed", parts: parts as never },
  } as GmailMessageFull;
}

// --- classificação ----------------------------------------------------------

Deno.test("extrairAnexos: assinatura inline (cid no HTML) marcada inlineNoCorpo", () => {
  const m = msg([
    htmlPart(`<p>Boa tarde! Segue anexo.</p><img src="cid:image001.jpg@01D">`),
    attachmentPart({
      filename: "image001.jpg",
      mimeType: "image/jpeg",
      size: 138023,
      disposition: "inline",
      contentId: "image001.jpg@01D",
    }),
  ]);
  const anexos = extrairAnexos(m);
  assertEquals(anexos.length, 1);
  assertEquals(anexos[0]!.inlineNoCorpo, true);
});

Deno.test("extrairAnexos: PDF anexado pelo clipe NÃO é inlineNoCorpo", () => {
  const m = msg([
    htmlPart(`<p>Segue NF.</p>`),
    attachmentPart({
      filename: "NFE-31260545.pdf",
      mimeType: "application/pdf",
      size: 15074,
      disposition: "attachment",
    }),
  ]);
  const anexos = extrairAnexos(m);
  assertEquals(anexos[0]!.inlineNoCorpo, false);
});

Deno.test("inlineNoCorpo via Content-ID mesmo sem Content-Disposition", () => {
  const m = msg([
    htmlPart(`<div>texto<img src='cid:logo@empresa'></div>`),
    attachmentPart({
      filename: "logo.png",
      mimeType: "image/png",
      size: 5000,
      contentId: "logo@empresa",
    }),
  ]);
  assertEquals(extrairAnexos(m)[0]!.inlineNoCorpo, true);
});

// --- seleção (o coração da regra) -------------------------------------------

Deno.test("NF 1486931: PDF real + assinatura inline → salva só o PDF", () => {
  const m = msg([
    htmlPart(`<p>Segue anexo.</p><img src="cid:image001.jpg@01D">`),
    attachmentPart({
      filename: "NFE-31260545.pdf",
      mimeType: "application/pdf",
      size: 15074,
      disposition: "attachment",
    }),
    attachmentPart({
      filename: "image001.jpg",
      mimeType: "image/jpeg",
      size: 138023,
      disposition: "inline",
      contentId: "image001.jpg@01D",
    }),
  ]);
  const { salvar, ignorados } = selecionarAnexosParaSalvar(extrairAnexos(m));
  assertEquals(salvar.map((a) => a.filename), ["NFE-31260545.pdf"]);
  assertEquals(ignorados.map((a) => a.filename), ["image001.jpg"]);
});

Deno.test("NF 647384: foto colada no corpo SEM outro anexo → é salva (não regride)", () => {
  const m = msg([
    htmlPart(`<p>Segue a foto do romaneio.</p><img src="cid:foto@gmail">`),
    attachmentPart({
      filename: "romaneio.jpg",
      mimeType: "image/jpeg",
      size: 400000,
      disposition: "inline",
      contentId: "foto@gmail",
    }),
  ]);
  const { salvar, ignorados } = selecionarAnexosParaSalvar(extrairAnexos(m));
  assertEquals(salvar.map((a) => a.filename), ["romaneio.jpg"]);
  assertEquals(ignorados.length, 0);
});

Deno.test("dois anexos reais + assinatura → salva os dois reais, ignora a assinatura", () => {
  const m = msg([
    htmlPart(`<p>Docs.</p><img src="cid:sig@x">`),
    attachmentPart({ filename: "nota.pdf", mimeType: "application/pdf", size: 10000, disposition: "attachment" }),
    attachmentPart({ filename: "foto.jpg", mimeType: "image/jpeg", size: 900000, disposition: "attachment" }),
    attachmentPart({ filename: "sig.png", mimeType: "image/png", size: 20000, disposition: "inline", contentId: "sig@x" }),
  ]);
  const { salvar, ignorados } = selecionarAnexosParaSalvar(extrairAnexos(m));
  assertEquals(salvar.map((a) => a.filename).sort(), ["foto.jpg", "nota.pdf"]);
  assertEquals(ignorados.map((a) => a.filename), ["sig.png"]);
});

Deno.test("sem anexo nenhum → listas vazias", () => {
  const { salvar, ignorados } = selecionarAnexosParaSalvar([]);
  assert(salvar.length === 0 && ignorados.length === 0);
});
