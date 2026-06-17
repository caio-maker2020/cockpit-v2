// Testes do parser do e-mail de rastreamento do SSW.
// Rodar: deno test supabase/functions/_shared/parser-email-ssw-rastreamento.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ehRemetenteSsw,
  normalizeNfEmail,
  parseEmailSswRastreamento,
} from "./parser-email-ssw-rastreamento.ts";

// Fixture: corpo (texto puro) do e-mail real ASTRAZENECA, 2026-06-16.
const FIXTURE_ASTRAZENECA = `Rastreamento de Cargas
Prezado Cliente,
Conforme solicitado, segue nova situação da carga por nós transportada:
Remetente: ASTRAZENECA DO BRASIL LTDA
Destinatário: ANTONIO ERNESTO BARBIERI
Notas Fiscais: 2 279985, 2 279986
Pedido:
Unidade: VIANA / ES
Data e Hora: 16/06/26 16:10:49
Nova Situação: 000 000032482 - 06 EXTRAVIO DE MERCADORIA
EXTRAVIO NA TRANSFERENCIA (SSWMOBILE)
Rastreamento completo`;

Deno.test("ehRemetenteSsw reconhece o remetente do SSW", () => {
  assert(ehRemetenteSsw("Sal Express <sswemail@ssw.inf.br>"));
  assert(ehRemetenteSsw("SSWEMAIL@SSW.INF.BR"));
  assert(!ehRemetenteSsw("cliente@acacia.com.br"));
  assert(!ehRemetenteSsw(null));
});

Deno.test("normalizeNfEmail remove série/espaços/zeros à esquerda", () => {
  assertEquals(normalizeNfEmail("279985"), "279985");
  assertEquals(normalizeNfEmail("000279985"), "279985");
  assertEquals(normalizeNfEmail("2 279985"), "2279985"); // só dígitos quando dado cru
  assertEquals(normalizeNfEmail(""), null);
});

Deno.test("parseEmailSswRastreamento extrai campos do e-mail ASTRAZENECA", () => {
  const r = parseEmailSswRastreamento(FIXTURE_ASTRAZENECA);

  assertEquals(r.remetente, "ASTRAZENECA DO BRASIL LTDA");
  assertEquals(r.destinatario, "ANTONIO ERNESTO BARBIERI");
  assertEquals(r.unidade, "VIANA / ES");
  assertEquals(r.dataHora, "16/06/26 16:10:49");

  // 2 NFs, série 2, números consecutivos
  assertEquals(r.notas.length, 2);
  assertEquals(r.notas[0], { raw: "2 279985", serie: "2", numero: "279985" });
  assertEquals(r.notas[1], { raw: "2 279986", serie: "2", numero: "279986" });

  // ocorrência 06 extravio
  assert(r.ocorrencia !== null);
  assertEquals(r.ocorrencia!.codigo, 6);
  assert(r.ocorrencia!.descricao.startsWith("EXTRAVIO DE MERCADORIA"));
});

Deno.test("parseEmailSswRastreamento: NF única sem série", () => {
  const corpo = `Remetente: CLIENTE TESTE LTDA
Destinatário: FULANO
Notas Fiscais: 0000345523
Unidade: POUSO ALEGRE / MG
Data e Hora: 16/06/26 10:00:00
Nova Situação: 000 000099999 - 06 EXTRAVIO DE MERCADORIA`;
  const r = parseEmailSswRastreamento(corpo);
  assertEquals(r.notas.length, 1);
  assertEquals(r.notas[0]!.numero, "345523"); // zeros à esquerda removidos
  assertEquals(r.notas[0]!.serie, null);
  assertEquals(r.ocorrencia!.codigo, 6);
});

Deno.test("parseEmailSswRastreamento: corpo sem campos retorna nulos", () => {
  const r = parseEmailSswRastreamento("e-mail qualquer sem rótulos");
  assertEquals(r.remetente, null);
  assertEquals(r.notas.length, 0);
  assertEquals(r.ocorrencia, null);
});

// Fixture HTML — formato REAL do e-mail SSW (tabela rótulo→valor, NFs em <a>,
// entidades acentuadas). Caio 2026-06-17: o corpo chega em HTML, não texto.
const FIXTURE_HTML = `<html><head><style>
  .t20 {font-size:10pt;width:20%;text-align:right;}
  .t80 {font-size:10pt;width:80%;}
</style></head><body>
<table><tr><td colspan=2><b>Rastreamento de Cargas</b></td></tr></table>
<table>
<tr><td class=t20><b>Remetente:</b></td><td class=t80>DUILIO DE DEUS</td></tr>
<tr><td class=t20><b>Destinat&aacute;rio:</b></td><td class=t80>CLIENTE FINAL XYZ</td></tr>
<tr><td class=t20><b>Notas Fiscais:</b></td><td class=t80><a href="http://ssw.inf.br/x">123456</a></td></tr>
<tr><td class=t20><b>Pedido:</b></td><td class=t80></td></tr>
<tr><td class=t20><b>Unidade:</b></td><td class=t80>POUSO ALEGRE / MG</td></tr>
<tr><td class=t20><b>Data e Hora:</b></td><td class=t80>17/06/26 10:05:00</td></tr>
<tr><td class=t20><b>Nova Situa&ccedil;&atilde;o:</b></td><td class=t80>000 000099999 - 49 SITUACAO NO RELACIONAMENTO<br>FALTA DE RETORNO (SSWMOBILE)</td></tr>
</table>
</body></html>`;

Deno.test("parseEmailSswRastreamento: e-mail HTML real (oc=49 relacionamento)", () => {
  const r = parseEmailSswRastreamento(FIXTURE_HTML);
  assertEquals(r.remetente, "DUILIO DE DEUS");
  assertEquals(r.destinatario, "CLIENTE FINAL XYZ");
  assertEquals(r.unidade, "POUSO ALEGRE / MG");
  assertEquals(r.dataHora, "17/06/26 10:05:00");
  assertEquals(r.notas.length, 1);
  assertEquals(r.notas[0]!.numero, "123456");
  assert(r.ocorrencia !== null);
  assertEquals(r.ocorrencia!.codigo, 49);
  assert(r.ocorrencia!.descricao.startsWith("SITUACAO NO RELACIONAMENTO"));
});

// Fixture do e-mail REAL recebido 2026-06-17 (já em texto, como htmlToText
// devolve): oc no formato DIRETO "49 TRATATIVA..." (sem prefixo "NNN NNNNN -")
// e com RODAPÉ que contém " - " (armadilha que vazava e quebrava o parse).
const FIXTURE_REAL_TEXTO =
  "Rastreamento de Cargas Prezado Cliente, Conforme solicitado, segue nova " +
  "situação da carga por nós transportada: Remetente: DUILIO DE DEUS " +
  "Destinatário: SAL EXPRESS SOLUCOES LOG TRANS (C.) Nota Fiscal: 123456 " +
  "Pedido: Unidade: VARGINHA / MG Data e Hora: 17/06/26 10:16:44 " +
  "Nova Situação: 49 TRATATIVA DE RELACIONAMENTO PARA LIBERACAO DE CARG TESTE " +
  "TESTE Rastreamento completo Informações importantes: - Para contatar-nos " +
  "utilize o endereço: atendimento@salexpress.com.br . - Emails que receberam " +
  "esta informação: cockpit@salexpress.com.br. Atenciosamente, Sal Express";

Deno.test("parseEmailSswRastreamento: e-mail REAL (oc direta 49 + rodapé com ' - ')", () => {
  const r = parseEmailSswRastreamento(FIXTURE_REAL_TEXTO);
  assertEquals(r.remetente, "DUILIO DE DEUS");
  assertEquals(r.destinatario, "SAL EXPRESS SOLUCOES LOG TRANS (C.)");
  assertEquals(r.unidade, "VARGINHA / MG");
  assertEquals(r.dataHora, "17/06/26 10:16:44");
  assertEquals(r.notas.length, 1);
  assertEquals(r.notas[0]!.numero, "123456");
  assert(r.ocorrencia !== null);
  assertEquals(r.ocorrencia!.codigo, 49); // NÃO pode virar null por causa do rodapé
  assert(r.ocorrencia!.descricao.startsWith("TRATATIVA DE RELACIONAMENTO"));
});

Deno.test("parseEmailSswRastreamento: HTML com 2 NFs em links separados", () => {
  const html = `<tr><td>Remetente:</td><td>FOO</td></tr>
<tr><td>Notas Fiscais:</td><td><a>2 279985</a>, <a>2 279986</a></td></tr>
<tr><td>Unidade:</td><td>VIANA / ES</td></tr>
<tr><td>Nova Situa&ccedil;&atilde;o:</td><td>000 1 - 10 RECUSA TOTAL</td></tr>`;
  const r = parseEmailSswRastreamento(html);
  assertEquals(r.notas.map((n) => n.numero), ["279985", "279986"]);
  assertEquals(r.ocorrencia!.codigo, 10);
});
