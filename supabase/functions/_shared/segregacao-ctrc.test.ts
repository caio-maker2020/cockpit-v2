// Guard da cerca de segregação (Caio 2026-09-21). Segregar CTRC bloqueia carga
// de verdade e o Cockpit NÃO desfaz (retirada é manual, opção 091). Cada trava
// aqui existe pra impedir que a marcação escape do escopo combinado:
// só PRATI, só oc 54/59, só aprovação humana.
// Rodar: deno test supabase/functions/_shared/segregacao-ctrc.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  lerMarcacaoSegregar,
  normalizarCnpj,
  OCS_COM_SEGREGACAO,
  segregacaoPermitida,
  type SegregacaoPermitidaArgs,
} from "./segregacao-ctrc.ts";

const PRATI_A = "73856593001057";
const PRATI_B = "73856593000166";
const AUTORIZADOS = new Set([PRATI_A, PRATI_B]);

const BASE: SegregacaoPermitidaArgs = {
  cnpjPagador: PRATI_A,
  codigoSsw: 54,
  cnpjsAutorizados: AUTORIZADOS,
  origemHumana: true,
};

Deno.test("caso feliz: PRATI + oc 54 + humano → permite", () => {
  assertEquals(segregacaoPermitida(BASE), true);
});

Deno.test("caso feliz: PRATI + oc 59 (extravio total) → permite", () => {
  assertEquals(segregacaoPermitida({ ...BASE, codigoSsw: 59 }), true);
});

Deno.test("os DOIS CNPJs do grupo PRATI são aceitos", () => {
  assertEquals(segregacaoPermitida({ ...BASE, cnpjPagador: PRATI_B }), true);
});

// --- cerca 1: cliente ----------------------------------------------------
Deno.test("cliente fora da whitelist NÃO segrega", () => {
  assertEquals(segregacaoPermitida({ ...BASE, cnpjPagador: "43648971000155" }), false);
});

Deno.test("whitelist vazia NÃO segrega ninguém (fail-closed)", () => {
  assertEquals(segregacaoPermitida({ ...BASE, cnpjsAutorizados: new Set() }), false);
});

Deno.test("CNPJ nulo/vazio/lixo NÃO segrega", () => {
  for (const cnpj of [null, undefined, "", "   ", "123", "abc", "7385659300105"]) {
    assertEquals(
      segregacaoPermitida({ ...BASE, cnpjPagador: cnpj }),
      false,
      `cnpj ${JSON.stringify(cnpj)} deveria ser recusado`,
    );
  }
});

Deno.test("CNPJ mascarado casa com a whitelist (normalização)", () => {
  assertEquals(segregacaoPermitida({ ...BASE, cnpjPagador: "73.856.593/0010-57" }), true);
});

// --- cerca 2: ocorrência -------------------------------------------------
Deno.test("oc fora de {54,59} NÃO segrega, nem para a PRATI", () => {
  for (const oc of [49, 55, 33, 44, 21, 6, 9, 16, 20, 1]) {
    assertEquals(
      segregacaoPermitida({ ...BASE, codigoSsw: oc }),
      false,
      `oc ${oc} não deveria segregar`,
    );
  }
});

Deno.test("oc nula NÃO segrega", () => {
  assertEquals(segregacaoPermitida({ ...BASE, codigoSsw: null }), false);
});

Deno.test("a lista de ocs com segregação é exatamente {54,59}", () => {
  assertEquals([...OCS_COM_SEGREGACAO].sort((a, b) => a - b), [54, 59]);
});

// --- cerca 3: origem humana ---------------------------------------------
Deno.test("ação autônoma/robô NUNCA segrega, mesmo PRATI + oc 54", () => {
  assertEquals(segregacaoPermitida({ ...BASE, origemHumana: false }), false);
});

Deno.test("robô não segrega nem na 59", () => {
  assertEquals(segregacaoPermitida({ ...BASE, codigoSsw: 59, origemHumana: false }), false);
});

// --- leitura da marcação -------------------------------------------------
Deno.test("lerMarcacaoSegregar aceita boolean e strings equivalentes", () => {
  assertEquals(lerMarcacaoSegregar({ segregar_ctrc: true }), true);
  assertEquals(lerMarcacaoSegregar({ segregar_ctrc: "true" }), true);
  assertEquals(lerMarcacaoSegregar({ segregar_ctrc: "S" }), true);
  assertEquals(lerMarcacaoSegregar({ segregar_ctrc: "s" }), true);
});

Deno.test("lerMarcacaoSegregar é false por omissão (default do portal = N)", () => {
  assertEquals(lerMarcacaoSegregar({ segregar_ctrc: false }), false);
  assertEquals(lerMarcacaoSegregar({ segregar_ctrc: "N" }), false);
  assertEquals(lerMarcacaoSegregar({ outra_coisa: true }), false);
  assertEquals(lerMarcacaoSegregar({}), false);
  assertEquals(lerMarcacaoSegregar(null), false);
  assertEquals(lerMarcacaoSegregar(undefined), false);
  assertEquals(lerMarcacaoSegregar("string"), false);
});

Deno.test("normalizarCnpj devolve vazio quando não tem 14 dígitos", () => {
  assertEquals(normalizarCnpj("73.856.593/0010-57"), PRATI_A);
  assertEquals(normalizarCnpj("123"), "");
  assertEquals(normalizarCnpj(null), "");
});
