// Testes da extração do Nº Remessa (SBD/Ingrid, onboarding 2026-08-11).
// A string dos Dados Adicionais espelha o DANFE REAL da NF 23/002467883
// (CTRC SBD492185-2, prints do Caio) — sem dados de cliente no repo.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extrairAlvosDeLink,
  extrairDadosAdicionaisDoXmlNfe,
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
