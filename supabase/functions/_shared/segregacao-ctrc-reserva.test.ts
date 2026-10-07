// =============================================================================
// RESERVA À OPERADORA (Carlos 2026-10-06, Larissa/PRATI — INV-169, ADR 0033).
//
// A cerca da segregação impede o robô de SEGREGAR, mas o robô continuava
// LANÇANDO a 54/59 sozinho pela janela de veto: 23 ações da PRATI entre 22/09 e
// 06/10, várias antes de a operadora começar o dia — a caixa de segregar nunca
// teve vez. Regra: se esta ação, aprovada por humano, poderia segregar, ela é da
// operadora. Este arquivo trava a regra PURA, o leitor da whitelist que separa
// "desligado" de "não consegui ler", e a decisão async usada pelo agendador e
// pelo vencimento.
//
// Rodar: deno test --allow-all --no-check \
//          supabase/functions/_shared/segregacao-ctrc-reserva.test.ts
// =============================================================================

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  avaliarReservaSegregacaoVeto,
  carregarWhitelistSegregacaoComStatus,
  type CardParaReservaSegregacao,
  segregacaoReservadaAoHumano,
  type SegregacaoReservaArgs,
} from "./segregacao-ctrc.ts";

const PRATI_A = "73856593001057";
const PRATI_B = "73856593000166";
const OUTRO_CLIENTE = "43648971000155";

/** Client falso no molde do segregacao-ctrc-loader.test.ts, contando leituras. */
function fakeDb(resp: {
  flag?: { data?: unknown; error?: { message: string } | null };
  whitelist?: { data?: unknown; error?: { message: string } | null };
  explode?: boolean;
} = {}) {
  const tabelasLidas: string[] = [];
  return {
    tabelasLidas,
    from(tabela: string) {
      if (resp.explode) throw new Error("boom: conexão caiu");
      tabelasLidas.push(tabela);
      const resultado = tabela === "feature_flags"
        ? (resp.flag ?? { data: { enabled: true }, error: null })
        : (resp.whitelist ?? { data: [{ cnpj_pagador: PRATI_A }, { cnpj_pagador: PRATI_B }], error: null });
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: () => Promise.resolve(resultado),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(resultado).then(ok),
      };
      return q;
    },
  };
}

/** Card de extravio real da PRATI no momento da sugestão: 49 do robô do D+4. */
const CARD_PRATI_EXTRAVIO: CardParaReservaSegregacao = {
  agent_state: { cnpj_pagador: PRATI_A, cod_ultima_ocorrencia: 49 },
  cod_ultima_ocorrencia: 49,
  agente_extravio_status: "lancou",
};

// --- regra pura --------------------------------------------------------------

const BASE: SegregacaoReservaArgs = {
  cnpjPagador: PRATI_A,
  codigoSsw: 54,
  codigosOcorrenciaCard: [49, 49],
  oc49LancadaPeloRoboDoExtravio: true,
  cnpjsAutorizados: new Set([PRATI_A, PRATI_B]),
};

Deno.test("reserva pura: PRATI + 54/59 + extravio comprovado → reservado à operadora", () => {
  assertEquals(segregacaoReservadaAoHumano(BASE), true);
  assertEquals(segregacaoReservadaAoHumano({ ...BASE, codigoSsw: 59 }), true);
  assertEquals(segregacaoReservadaAoHumano({ ...BASE, codigosOcorrenciaCard: [6, null], oc49LancadaPeloRoboDoExtravio: false }), true);
});

Deno.test("reserva pura: fora do escopo da segregação → NÃO reserva (robô segue como hoje)", () => {
  assertEquals(segregacaoReservadaAoHumano({ ...BASE, cnpjPagador: OUTRO_CLIENTE }), false, "outro cliente");
  assertEquals(segregacaoReservadaAoHumano({ ...BASE, codigoSsw: 21 }), false, "oc 21");
  assertEquals(segregacaoReservadaAoHumano({ ...BASE, codigosOcorrenciaCard: [10, 10] }), false, "recusa");
  assertEquals(
    segregacaoReservadaAoHumano({ ...BASE, oc49LancadaPeloRoboDoExtravio: false }),
    false,
    "49 sem prova do robô não é extravio (Carlos 06/10)",
  );
  assertEquals(segregacaoReservadaAoHumano({ ...BASE, cnpjsAutorizados: new Set() }), false, "segregação desligada");
});

// --- leitor da whitelist com status -----------------------------------------

Deno.test("whitelist com status: flag ON + CNPJs ativos → ok com os CNPJs", async () => {
  const r = await carregarWhitelistSegregacaoComStatus(fakeDb());
  assertEquals(r.ok, true);
  if (r.ok) assertEquals([...r.cnpjs].sort(), [PRATI_B, PRATI_A].sort());
});

Deno.test("whitelist com status: flag OFF ou ausente → ok com Set vazio, sem ler a tabela", async () => {
  for (const flag of [{ data: { enabled: false }, error: null }, { data: null, error: null }]) {
    const db = fakeDb({ flag });
    const r = await carregarWhitelistSegregacaoComStatus(db);
    assertEquals(r.ok, true);
    if (r.ok) assertEquals(r.cnpjs.size, 0);
    assertEquals(db.tabelasLidas, ["feature_flags"]);
  }
});

Deno.test("whitelist com status: erro ao ler a FLAG → ok:false (não vira 'desligado')", async () => {
  const r = await carregarWhitelistSegregacaoComStatus(fakeDb({ flag: { data: null, error: { message: "RLS" } } }));
  assertEquals(r.ok, false);
});

Deno.test("whitelist com status: erro, formato estranho ou exceção na whitelist → ok:false", async () => {
  for (const db of [
    fakeDb({ whitelist: { data: null, error: { message: "timeout" } } }),
    fakeDb({ whitelist: { data: [{ cnpj_pagador: PRATI_A }], error: { message: "parcial" } } }),
    fakeDb({ whitelist: { data: "lixo", error: null } }),
    fakeDb({ explode: true }),
  ]) {
    assertEquals((await carregarWhitelistSegregacaoComStatus(db)).ok, false);
  }
});

// --- decisão async (agendador + vencimento) ----------------------------------

Deno.test("avaliar: 54 e 59 (com e sem e-mail) em card de extravio da PRATI → reservado", async () => {
  for (const acao of [
    "lancar_oc_e_enviar_email:54",
    "lancar_oc_e_enviar_email:59",
    "lancar_ocorrencia:54",
    "lancar_ocorrencia:59",
  ]) {
    const r = await avaliarReservaSegregacaoVeto(fakeDb(), acao, CARD_PRATI_EXTRAVIO);
    assertEquals(r.reservado, true, acao);
  }
});

Deno.test("avaliar: 'aguardar' nunca reserva e NÃO consulta o banco", async () => {
  const db = fakeDb();
  const r = await avaliarReservaSegregacaoVeto(db, "ignorar_e_aguardar:54", CARD_PRATI_EXTRAVIO);
  assertEquals(r.reservado, false);
  assertEquals(db.tabelasLidas, []);
});

Deno.test("avaliar: ações que não são 54/59 nunca reservam e NÃO consultam o banco", async () => {
  for (const acao of ["lancar_ocorrencia:21", "lancar_ocorrencia:56", "lancar_oc33_solo_portal:33", "lancar_ocorrencia:55", "", "sem_codigo"]) {
    const db = fakeDb();
    const r = await avaliarReservaSegregacaoVeto(db, acao, CARD_PRATI_EXTRAVIO);
    assertEquals(r.reservado, false, acao);
    assertEquals(db.tabelasLidas, [], `${acao} não pode custar leitura`);
  }
  assertEquals((await avaliarReservaSegregacaoVeto(fakeDb(), null, CARD_PRATI_EXTRAVIO)).reservado, false);
});

Deno.test("avaliar: outro cliente, recusa e 49 sem prova → robô segue como hoje", async () => {
  const casos: Array<[string, CardParaReservaSegregacao]> = [
    ["outro cliente", { ...CARD_PRATI_EXTRAVIO, agent_state: { cnpj_pagador: OUTRO_CLIENTE, cod_ultima_ocorrencia: 49 } }],
    ["PRATI em recusa", { agent_state: { cnpj_pagador: PRATI_A, cod_ultima_ocorrencia: 10 }, cod_ultima_ocorrencia: 10, agente_extravio_status: null }],
    ["PRATI 49 de relacionamento (sem robô)", { agent_state: { cnpj_pagador: PRATI_A, cod_ultima_ocorrencia: 49 }, cod_ultima_ocorrencia: 49, agente_extravio_status: null }],
    ["PRATI 49 com status nao_rodou", { agent_state: { cnpj_pagador: PRATI_A, cod_ultima_ocorrencia: 49 }, cod_ultima_ocorrencia: 49, agente_extravio_status: "nao_rodou" }],
    ["PRATI sem CNPJ no agent_state", { agent_state: {}, cod_ultima_ocorrencia: 49, agente_extravio_status: "lancou" }],
  ];
  for (const [nome, card] of casos) {
    const r = await avaliarReservaSegregacaoVeto(fakeDb(), "lancar_oc_e_enviar_email:54", card);
    assertEquals(r.reservado, false, nome);
  }
});

Deno.test("avaliar: extravio do SSW direto (6/9/16) reserva mesmo sem a marca do robô", async () => {
  for (const oc of [6, 9, 16]) {
    const card: CardParaReservaSegregacao = {
      agent_state: { cnpj_pagador: PRATI_B, cod_ultima_ocorrencia: oc },
      cod_ultima_ocorrencia: oc,
      agente_extravio_status: null,
    };
    assertEquals((await avaliarReservaSegregacaoVeto(fakeDb(), "lancar_ocorrencia:59", card)).reservado, true, `oc ${oc}`);
  }
});

Deno.test("avaliar: segregação DESLIGADA (flag OFF) → não reserva (robô volta a agir)", async () => {
  const r = await avaliarReservaSegregacaoVeto(
    fakeDb({ flag: { data: { enabled: false }, error: null } }),
    "lancar_oc_e_enviar_email:54",
    CARD_PRATI_EXTRAVIO,
  );
  assertEquals(r.reservado, false);
});

Deno.test("avaliar: NA DÚVIDA reserva — card ilegível, flag ilegível, whitelist ilegível, exceção", async () => {
  assertEquals((await avaliarReservaSegregacaoVeto(fakeDb(), "lancar_ocorrencia:54", null)).reservado, true, "card nulo");
  for (const db of [
    fakeDb({ flag: { data: null, error: { message: "RLS" } } }),
    fakeDb({ whitelist: { data: null, error: { message: "timeout" } } }),
    fakeDb({ explode: true }),
  ]) {
    const r = await avaliarReservaSegregacaoVeto(db, "lancar_oc_e_enviar_email:59", CARD_PRATI_EXTRAVIO);
    assertEquals(r.reservado, true);
  }
});

Deno.test("avaliar: card que já recebeu a 54 (card=54) mas agent_state ainda 49 do robô → reserva", async () => {
  // Mesmo par de fontes do executor: o executor sobrescreve cards.cod a cada lançamento.
  const card: CardParaReservaSegregacao = {
    agent_state: { cnpj_pagador: PRATI_A, cod_ultima_ocorrencia: 49 },
    cod_ultima_ocorrencia: 54,
    agente_extravio_status: "lancou",
  };
  assertEquals((await avaliarReservaSegregacaoVeto(fakeDb(), "lancar_ocorrencia:54", card)).reservado, true);
});
