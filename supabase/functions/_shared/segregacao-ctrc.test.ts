// Guard da cerca de segregação (Caio 2026-09-21). Segregar CTRC bloqueia carga
// de verdade e o Cockpit NÃO desfaz (retirada é manual, opção 091). Cada trava
// aqui existe pra impedir que a marcação escape do escopo combinado:
// só PRATI, só oc 54/59, só aprovação humana.
// Rodar: deno test supabase/functions/_shared/segregacao-ctrc.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ehCardDeExtravioComprovado,
  lerMarcacaoSegregar,
  normalizarCnpj,
  OC_49_TRATATIVA_RELACIONAMENTO,
  OCS_CARD_EXTRAVIO,
  OCS_COM_SEGREGACAO,
  origemHumanaComprovada,
  roboDoExtravioLancou49,
  segregacaoPermitida,
  type SegregacaoPermitidaArgs,
} from "./segregacao-ctrc.ts";
import { EXTRAVIO_OCS } from "./agente-extravio-regras.ts";

const PRATI_A = "73856593001057";
const PRATI_B = "73856593000166";
const AUTORIZADOS = new Set([PRATI_A, PRATI_B]);

const BASE: SegregacaoPermitidaArgs = {
  cnpjPagador: PRATI_A,
  codigoSsw: 54,
  // 49 lançada pelo ROBÔ DO EXTRAVIO ("PRAZO DE PERDAS EXPIRADO", D+4) — é o
  // estado do card no momento em que a operadora recebe a sugestão de 54/59.
  // A 49 em si é "Tratativa de relacionamento" (Carlos 06/10): sem a prova do
  // robô ela NÃO é extravio — ver o bloco "49 não é extravio" abaixo.
  codigosOcorrenciaCard: [49, null],
  oc49LancadaPeloRoboDoExtravio: true,
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

// ---------------------------------------------------------------------------
// origemHumanaComprovada — achado da auditoria pre-merge de 21/09.
// O executor lia `todos.auto_approval_rule` IGNORANDO o `error` do SELECT, e
// `?? null` transformava "nao consegui ler" em "regra nula" = "foi humano".
// Numa cerca cujo efeito e IRREVERSIVEL pelo Cockpit, isso e fail-OPEN.
// ---------------------------------------------------------------------------

Deno.test("origem humana: todo lido e sem regra automatica = humano", () => {
  assertEquals(origemHumanaComprovada({ leuTodo: true, regraAuto: null }), true);
  assertEquals(origemHumanaComprovada({ leuTodo: true, regraAuto: undefined }), true);
});

Deno.test("origem humana: todo lido COM regra automatica = robo, nao segrega", () => {
  assertEquals(origemHumanaComprovada({ leuTodo: true, regraAuto: "oc49_autonoma" }), false);
  assertEquals(origemHumanaComprovada({ leuTodo: true, regraAuto: "" }), false);
});

Deno.test("origem humana: SELECT falhou = NAO comprovada (fail-closed)", () => {
  // Erro de query/RLS/timeout. Antes do fix isto virava `true`.
  assertEquals(origemHumanaComprovada({ leuTodo: false, regraAuto: null }), false);
});

Deno.test("origem humana: todo inexistente = NAO comprovada (fail-closed)", () => {
  assertEquals(origemHumanaComprovada({ leuTodo: false, regraAuto: undefined }), false);
});

Deno.test("origem humana: leitura falha vence ate quando a regra diz humano", () => {
  // O ponto do fix: `leuTodo` e condicao NECESSARIA. Ausencia de prova nao e
  // prova de ausencia de robo.
  for (const regra of [null, undefined, "qualquer_regra"]) {
    assertEquals(origemHumanaComprovada({ leuTodo: false, regraAuto: regra }), false);
  }
});

Deno.test("cerca completa: sem origem humana comprovada, nem PRATI segrega", () => {
  // Integra as duas funcoes: e o caminho real do executor.
  assertEquals(
    segregacaoPermitida({
      ...BASE,
      cnpjPagador: PRATI_A,
      codigoSsw: 54,
      origemHumana: origemHumanaComprovada({ leuTodo: false, regraAuto: null }),
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Escopo "somente cards de extravio" (Caio 21/09). A auditoria pre-merge achou
// que essa frase estava no pedido, na migration e na tela — mas NAO no codigo.
// ---------------------------------------------------------------------------

Deno.test("extravio: as 3 ocorrencias de extravio do SSW (6/9/16) permitem, com ou sem prova da 49", () => {
  for (const oc of [6, 9, 16]) {
    for (const prova of [true, false]) {
      assertEquals(
        segregacaoPermitida({ ...BASE, codigosOcorrenciaCard: [oc, null], oc49LancadaPeloRoboDoExtravio: prova }),
        true,
        `oc de card ${oc} (prova49=${prova}) deveria permitir`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Carlos 06/10: "a 49 não é ocorrência de extravio". No dicionário ela é
// "Tratativa de relacionamento". Entrou no conjunto em 21/09 como atalho (o
// robô do extravio lança uma 49 no D+4) e com isso QUALQUER 49 de
// relacionamento passava por card de extravio — em 06/10, 2 dos 6 cards
// abertos da PRATI com 49 não tinham extravio comprovado (NF 1036215, 1037313).
// ---------------------------------------------------------------------------

Deno.test("49 não é extravio: 49 SEM a prova do robô do extravio NÃO segrega", () => {
  assertEquals(
    segregacaoPermitida({ ...BASE, codigosOcorrenciaCard: [49, 49], oc49LancadaPeloRoboDoExtravio: false }),
    false,
    "49 de tratativa de relacionamento comum não pode barrar carga",
  );
});

Deno.test("49 não é extravio: 49 COM a prova do robô do extravio segrega (fluxo real D+4)", () => {
  assertEquals(segregacaoPermitida({ ...BASE, codigosOcorrenciaCard: [49, 49] }), true);
});

Deno.test("49 não é extravio: a prova só vale para a 49 — não transforma recusa em extravio", () => {
  // agente_extravio_status='lancou' é marca que PERSISTE no card (ciclo antigo).
  // Num card que hoje está em recusa (10), a marca velha não pode abrir a cerca.
  for (const oc of [10, 11, 19, 35, 54, 59]) {
    assertEquals(
      segregacaoPermitida({ ...BASE, codigosOcorrenciaCard: [oc, oc], oc49LancadaPeloRoboDoExtravio: true }),
      false,
      `oc ${oc} com marca de 49 do robô NAO deveria permitir`,
    );
  }
});

Deno.test("49 não é extravio: a prova é exatamente agente_extravio_status = 'lancou'", () => {
  assertEquals(roboDoExtravioLancou49("lancou"), true);
  for (const v of [null, undefined, "", "nao_rodou", "recomendado", "LANCOU", " lancou", true, 1]) {
    assertEquals(roboDoExtravioLancou49(v), false, `status ${JSON.stringify(v)} não prova a 49`);
  }
});

Deno.test("49 não é extravio: a constante da 49 é 49 e NÃO está no conjunto de extravio", () => {
  assertEquals(OC_49_TRATATIVA_RELACIONAMENTO, 49);
  assertEquals(OCS_CARD_EXTRAVIO.has(49), false);
});

Deno.test("ehCardDeExtravioComprovado: fail-closed com lista vazia/nulos", () => {
  assertEquals(ehCardDeExtravioComprovado([], true), false);
  assertEquals(ehCardDeExtravioComprovado([null, undefined], true), false);
  assertEquals(ehCardDeExtravioComprovado([49], false), false);
  assertEquals(ehCardDeExtravioComprovado([49], true), true);
  assertEquals(ehCardDeExtravioComprovado([null, 16], false), true);
});

Deno.test("extravio: card de RECUSA da PRATI com 54 proposta NAO segrega", () => {
  // O caso concreto do achado: recusa (10/11/19/35) nao e extravio. Barrar a
  // carga de uma recusa e irreversivel pelo Cockpit.
  for (const oc of [10, 11, 19, 35]) {
    assertEquals(
      segregacaoPermitida({ ...BASE, codigosOcorrenciaCard: [oc, oc] }),
      false,
      `oc de card ${oc} NAO deveria permitir`,
    );
  }
});

Deno.test("extravio: sem nenhuma ocorrencia de card = fail-closed", () => {
  assertEquals(segregacaoPermitida({ ...BASE, codigosOcorrenciaCard: [] }), false);
  assertEquals(segregacaoPermitida({ ...BASE, codigosOcorrenciaCard: [null, null] }), false);
  assertEquals(segregacaoPermitida({ ...BASE, codigosOcorrenciaCard: [undefined] }), false);
});

Deno.test("extravio: basta UMA fonte bater — o card ja lancou a 54 e virou 54", () => {
  // Fluxo real: o executor sobrescreve cards.cod_ultima_ocorrencia a cada
  // lancamento. Num relancamento o campo do card ja vale 54, mas o agent_state
  // guarda o 49. Olhar so o campo do card mataria a feature em silencio.
  assertEquals(
    segregacaoPermitida({ ...BASE, codigosOcorrenciaCard: [49, 54] }),
    true,
    "agent_state=49 (do robô do extravio) + card=54 (ja lancado) deveria permitir",
  );
  assertEquals(
    segregacaoPermitida({ ...BASE, codigosOcorrenciaCard: [49, 54], oc49LancadaPeloRoboDoExtravio: false }),
    false,
    "agent_state=49 SEM prova + card=54 NAO deveria permitir (49 não é extravio)",
  );
  assertEquals(
    segregacaoPermitida({ ...BASE, codigosOcorrenciaCard: [null, 9], oc49LancadaPeloRoboDoExtravio: false }),
    true,
    "card=9 (extravio) deveria permitir mesmo sem agent_state",
  );
});

Deno.test("extravio: OCS_CARD_EXTRAVIO e exatamente {6,9,16} (Carlos 06/10: 49 saiu)", () => {
  assertEquals([...OCS_CARD_EXTRAVIO].sort((a, b) => a - b), [6, 9, 16]);
});

Deno.test("extravio: OCS_CARD_EXTRAVIO é o MESMO conjunto do agente de extravio (EXTRAVIO_OCS)", () => {
  // Duas listas de "o que é extravio" que divergem = a cerca e o robô do D+4
  // discordando sobre o mesmo card. Paridade travada.
  assertEquals(
    [...OCS_CARD_EXTRAVIO].sort((a, b) => a - b),
    [...EXTRAVIO_OCS].sort((a, b) => a - b),
  );
});
