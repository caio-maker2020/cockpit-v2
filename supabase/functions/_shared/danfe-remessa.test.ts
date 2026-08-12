// Testes da extração do Nº Remessa (SBD/Ingrid, onboarding 2026-08-11).
// A string dos Dados Adicionais espelha o DANFE REAL da NF 23/002467883
// (CTRC SBD492185-2, prints do Caio) — sem dados de cliente no repo.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  descompactarXmlDoZip,
  desescaparHtml,
  extrairAlvosDeLink,
  extrairDadosAdicionaisDoXmlNfe,
  extrairLinkXmlNfe,
  extrairNumeroRemessa,
  extrairNumeroRemessaDoXmlNfe,
} from "./danfe-remessa.ts";

const DADOS_ADICIONAIS_REAIS = "No Ordem de venda: 153681253 No Remessa: 1262024921";

Deno.test("caso real: acha a remessa e NUNCA a ordem de venda", () => {
  assertEquals(extrairNumeroRemessa(DADOS_ADICIONAIS_REAIS), "1262024921");
});

Deno.test("variações de grafia do rótulo", () => {
  for (const t of [
    "Nº Remessa: 1261962099",
    "N. Remessa 1261962099",
    "Nro Remessa:1261962099",
    "REMESSA: 1261962099",
    "no remessa   1261962099",
  ]) {
    assertEquals(extrairNumeroRemessa(t), "1261962099", `falhou em: ${t}`);
  }
});

Deno.test("sem 'Remessa' no texto → null (ordem de venda sozinha não casa)", () => {
  assertEquals(extrairNumeroRemessa("No Ordem de venda: 153681253"), null);
  assertEquals(extrairNumeroRemessa("Pedido: 132671 EAN: 88591141752"), null);
  assertEquals(extrairNumeroRemessa(""), null);
  assertEquals(extrairNumeroRemessa(null), null);
});

Deno.test("número curto demais não casa (evita lixo tipo 'Remessa: 2')", () => {
  assertEquals(extrairNumeroRemessa("Remessa: 12345"), null);
});

Deno.test("XML da NF-e: infCpl direto", () => {
  const xml = `<NFe><infNFe><infAdic><infCpl>${DADOS_ADICIONAIS_REAIS}</infCpl></infAdic></infNFe></NFe>`;
  assertEquals(extrairNumeroRemessaDoXmlNfe(xml), "1262024921");
});

Deno.test("XML com namespace e CDATA", () => {
  const xml =
    `<nfe:NFe xmlns:nfe="http://www.portalfiscal.inf.br/nfe"><nfe:infAdic><nfe:infCpl><![CDATA[${DADOS_ADICIONAIS_REAIS}]]></nfe:infCpl></nfe:infAdic></nfe:NFe>`;
  assertEquals(extrairNumeroRemessaDoXmlNfe(xml), "1262024921");
});

Deno.test("XML com remessa só no infAdFisco (fonte secundária)", () => {
  const xml = `<NFe><infAdic><infAdFisco>No Remessa: 1261950181</infAdFisco></infAdic></NFe>`;
  assertEquals(extrairNumeroRemessaDoXmlNfe(xml), "1261950181");
});

Deno.test("XML sem infCpl → null (vira evidência 'remessa ausente')", () => {
  assertEquals(extrairNumeroRemessaDoXmlNfe("<NFe><infNFe></infNFe></NFe>"), null);
  assertEquals(extrairDadosAdicionaisDoXmlNfe("<NFe/>"), null);
});

Deno.test("entidades escapadas no infCpl não atrapalham", () => {
  const xml = `<NFe><infAdic><infCpl>Cliente A&amp;B - No Remessa: 1262024921</infCpl></infAdic></NFe>`;
  assertEquals(extrairNumeroRemessaDoXmlNfe(xml), "1262024921");
});

// ── parser de links das telas SSW ────────────────────────────────────────────
Deno.test("acha o link DANFEs no menu do detalhe 101 (href)", () => {
  const html = `<a href="/bin/ssw0053?act=DAN&seq_ctrc=123"><u>D</u>ANFEs</a>`;
  assertEquals(extrairAlvosDeLink(html, "ANFEs"), ["/bin/ssw0053?act=DAN&seq_ctrc=123"]);
});

Deno.test("acha o link no padrão onclick com URL entre aspas simples", () => {
  const html = `<a href="#" onclick="abre('/bin/ssw0053?act=XML&chave=312608');return false">XML NF</a>`;
  assertEquals(extrairAlvosDeLink(html, "XML"), ["/bin/ssw0053?act=XML&chave=312608"]);
});

Deno.test("multiplos links do mesmo rótulo preservam a ordem das linhas", () => {
  const html = `<a href="/x1">Impr</a> ... <a href="/x2">Impr</a>`;
  assertEquals(extrairAlvosDeLink(html, "Impr"), ["/x1", "/x2"]);
});

Deno.test("rótulo ausente → lista vazia (nunca lança)", () => {
  assertEquals(extrairAlvosDeLink("<p>nada aqui</p>", "XML"), []);
  assertEquals(extrairAlvosDeLink(null, "XML"), []);
});

// ── Fluxo real do XML NF-e (validado ao vivo 2026-08-12) ─────────────────────
// A linha da tela DANFES vem 2x-escapada; o link "XML NF-e" é href real ssw1188.
const LINHA_DANFES_2X = "&amp;lt;f11&amp;gt;&amp;lt;!--XML NF-e--&amp;gt;&amp;lt;a class=sra " +
  "href='https://ssw.inf.br/cgi-local/ssw1188?id=4B3031313034333930' " +
  "onclick='window.open(this.href)'&amp;gt;&amp;lt;u&amp;gt;XML NF-e&amp;lt;/u&amp;gt;&amp;lt;/a&amp;gt;&amp;lt;/f11&amp;gt;";

Deno.test("desescaparHtml resolve escape aninhado (2x)", () => {
  const u = desescaparHtml(LINHA_DANFES_2X);
  if (!u.includes("<a class=sra")) throw new Error("não desescapou: " + u.slice(0, 60));
});

Deno.test("extrairLinkXmlNfe pega o href real ssw1188", () => {
  const href = extrairLinkXmlNfe(desescaparHtml(LINHA_DANFES_2X));
  assertEquals(href, "https://ssw.inf.br/cgi-local/ssw1188?id=4B3031313034333930");
});

Deno.test("extrairLinkXmlNfe → null quando não há link", () => {
  assertEquals(extrairLinkXmlNfe("<td>sem xml aqui</td>"), null);
});

Deno.test("descompactarXmlDoZip: ZIP real (deflate) → XML com a Remessa", async () => {
  // ZIP mínimo gerado com o infCpl real (deflate via CompressionStream).
  const xml = `<?xml version="1.0"?><NFe><infNFe><infAdic><infCpl>No Ordem de venda: 1536012537 No Remessa: 1262026921</infCpl></infAdic></infNFe></NFe>`;
  const raw = new TextEncoder().encode(xml);
  const comp = new Uint8Array(await new Response(
    new Blob([raw as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw")),
  ).arrayBuffer());
  // monta local file header ZIP (method 8 deflate, csize conhecido)
  const nome = new TextEncoder().encode("nfe.xml");
  const h = new Uint8Array(30 + nome.length + comp.length);
  const dv = new DataView(h.buffer);
  dv.setUint32(0, 0x04034b50, true); dv.setUint16(8, 8, true);
  dv.setUint32(18, comp.length, true); dv.setUint32(22, raw.length, true);
  dv.setUint16(26, nome.length, true);
  h.set(nome, 30); h.set(comp, 30 + nome.length);
  const out = await descompactarXmlDoZip(h);
  assertEquals(extrairNumeroRemessaDoXmlNfe(out), "1262026921");
});
