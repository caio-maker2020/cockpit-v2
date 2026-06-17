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
