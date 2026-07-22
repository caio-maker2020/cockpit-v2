// Guard de não-regressão da REGRESSÃO NF 175621/10415 (Caio 2026-06-24): card que
// lançou oc=54 pelo Cockpit voltou pra AGUARDANDO VOCÊ porque o Bastão lagava na
// oc ANTERIOR (49 datada ANTES do lançamento de 54). A oc do Bastão só conta como
// "nova" se for MAIS RECENTE que o lançamento de 54. <= é lag → NÃO rebaixar.
//
// Rodar: deno test supabase/functions/_shared/lag-lancamento-54.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classificarPorData,
  dataBrtDeTimestamp,
  decidirReaberturaPorSsw,
  ehLagDeLancamento54PorData,
  parseSswDataHoraBrt,
  passDDevePreservarBannerIaSugestao,
} from "./lag-lancamento-54.ts";

// --- classificarPorData: lag (data) / nova (data) / ambiguo (mesmo dia → SSW) --
Deno.test("classificar: oc do Bastão ANTES do lançamento → lag (resolve por data)", () => {
  assertEquals(classificarPorData("2026-06-19", "2026-06-24"), "lag");
});
Deno.test("classificar: oc do Bastão DEPOIS do lançamento → nova (resolve por data)", () => {
  assertEquals(classificarPorData("2026-06-25", "2026-06-24"), "nova");
});
Deno.test("classificar: MESMO DIA → ambiguo (precisa desempate SSW)", () => {
  assertEquals(classificarPorData("2026-06-24", "2026-06-24"), "ambiguo");
});
Deno.test("classificar: sem lançamento de 54 → nova (fluxo normal, não é lag de 54)", () => {
  assertEquals(classificarPorData("2026-06-19", null), "nova");
});
Deno.test("classificar: sem data do Bastão mas teve 54 → lag (conservador)", () => {
  assertEquals(classificarPorData(null, "2026-06-24"), "lag");
});

Deno.test("NF 175621: oc do Bastão (06-19) ANTERIOR ao lançamento de 54 (06-24) → é lag, NÃO rebaixa", () => {
  assertEquals(ehLagDeLancamento54PorData("2026-06-19", "2026-06-24"), true);
});

Deno.test("mesmo dia → conservador: conta como lag (zero retrabalho)", () => {
  assertEquals(ehLagDeLancamento54PorData("2026-06-24", "2026-06-24"), true);
});

Deno.test("oc do Bastão MAIS RECENTE que o lançamento de 54 → oc nova, pode avaliar", () => {
  assertEquals(ehLagDeLancamento54PorData("2026-06-25", "2026-06-24"), false);
});

Deno.test("Cockpit nunca lançou 54 → não é lag de 54 (deixa o fluxo normal decidir)", () => {
  assertEquals(ehLagDeLancamento54PorData("2026-06-19", null), false);
});

Deno.test("teve lançamento de 54 mas sem data do Bastão → conservador: não rebaixa", () => {
  assertEquals(ehLagDeLancamento54PorData(null, "2026-06-24"), true);
});

Deno.test("dataBrtDeTimestamp: 19:45 UTC vira 16:45 BRT, mesma data", () => {
  assertEquals(dataBrtDeTimestamp("2026-06-24T19:45:01.000Z"), "2026-06-24");
});

Deno.test("dataBrtDeTimestamp: 01:00 UTC vira 22:00 BRT do dia ANTERIOR", () => {
  assertEquals(dataBrtDeTimestamp("2026-06-25T01:00:00.000Z"), "2026-06-24");
});

// === GENERALIZAÇÃO p/ QUALQUER oc lançada pelo Cockpit (Caio 2026-06-25, NF 351193) ===
// O fix de 54 (10415) era estreito. A 351193 lançou oc=56 (não 54), foi pra TRANSFERIDO,
// e voltava travada em AVH porque o Bastão lagava na oc=49 (datada ANTES do lançamento).
// ehLagDeLancamentoCockpit usa o MESMO discriminador por data, mas pra QUALQUER oc
// (ultimaDataLancamentoCockpitBrt não filtra codigo_oc). A lógica de data é a de
// ehLagDeLancamento54PorData — aqui travamos o cenário 351193 explicitamente.
Deno.test("NF 351193: lançou 56 em 25/06, Bastão lag na oc=49 de 11/06 → lag → NÃO reabre", () => {
  assertEquals(ehLagDeLancamento54PorData("2026-06-11", "2026-06-25"), true);
  assertEquals(classificarPorData("2026-06-11", "2026-06-25"), "lag");
});
Deno.test("oc nova DEPOIS de qualquer lançamento → não é lag → reabre normalmente", () => {
  assertEquals(ehLagDeLancamento54PorData("2026-06-26", "2026-06-25"), false);
});
Deno.test("sem lançamento do Cockpit (ex: extravio) → não é lag → reabre", () => {
  assertEquals(ehLagDeLancamento54PorData("2026-06-11", null), false);
});

// ===========================================================================
// VERDADE DO SSW POR HORA (Caio 2026-06-25, NF 346778 — raiz definitiva).
// Discriminador por DATA não distingue 2 ocorrências no mesmo dia → usa a HORA
// real do SSW. parseSswDataHoraBrt + decidirReaberturaPorSsw.
// ===========================================================================

// --- parseSswDataHoraBrt: "DD/MM/YY HH:MM" BRT → epoch ms UTC ---------------
Deno.test("parse: 25/06/26 09:47 BRT → 12:47 UTC", () => {
  assertEquals(parseSswDataHoraBrt("25/06/26 09:47"), Date.UTC(2026, 5, 25, 12, 47));
});
Deno.test("parse: 09:23 < 09:47 (mesmo dia) — ordem preservada", () => {
  const a = parseSswDataHoraBrt("25/06/26 09:23")!;
  const b = parseSswDataHoraBrt("25/06/26 09:47")!;
  assertEquals(a < b, true);
});
Deno.test("parse: vira do dia 31/12 23:59 BRT → 01/01 02:59 UTC", () => {
  assertEquals(parseSswDataHoraBrt("31/12/26 23:59"), Date.UTC(2027, 0, 1, 2, 59));
});
Deno.test("parse: SÓ data (sem hora) → null (cai no indefinido, nunca em 0)", () => {
  assertEquals(parseSswDataHoraBrt("25/06/26"), null);
});
Deno.test("parse: vazio/null/lixo → null", () => {
  assertEquals(parseSswDataHoraBrt(""), null);
  assertEquals(parseSswDataHoraBrt(null), null);
  assertEquals(parseSswDataHoraBrt("--"), null);
});

// --- decidirReaberturaPorSsw -------------------------------------------------
const RELAC = new Set([3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49, 54, 57]);
const ehRelac = (oc: number) => RELAC.has(oc);
const T = (s: string) => parseSswDataHoraBrt(s)!;

Deno.test("346778: Cockpit lançou 33 às 09:23, SSW mais recente=49 às 09:47 (mesmo dia) → REABRE", () => {
  assertEquals(
    decidirReaberturaPorSsw({
      ocSswMaisRecente: 49, ocSswMaisRecenteMs: T("25/06/26 09:47"),
      ehRelac, ultimoLancamentoCockpitMs: T("25/06/26 09:23"),
    }),
    "reabrir",
  );
});

Deno.test("351193: Cockpit lançou 56, SSW mais recente=56 (não-relac) → SUPRIME (sem bounce-back)", () => {
  assertEquals(
    decidirReaberturaPorSsw({
      ocSswMaisRecente: 56, ocSswMaisRecenteMs: T("25/06/26 10:00"),
      ehRelac, ultimoLancamentoCockpitMs: T("25/06/26 10:00"),
    }),
    "suprimir",
  );
});

Deno.test("fictício 1212 (Caio): lançou 56 10:40, operação lançou 49 nova 10:45 → REABRE", () => {
  assertEquals(
    decidirReaberturaPorSsw({
      ocSswMaisRecente: 49, ocSswMaisRecenteMs: T("25/06/26 10:45"),
      ehRelac, ultimoLancamentoCockpitMs: T("25/06/26 10:40"),
    }),
    "reabrir",
  );
});

Deno.test("49 PROVADAMENTE anterior ao lançamento (lag de verdade) → SUPRIME", () => {
  assertEquals(
    decidirReaberturaPorSsw({
      ocSswMaisRecente: 49, ocSswMaisRecenteMs: T("11/06/26 08:00"),
      ehRelac, ultimoLancamentoCockpitMs: T("25/06/26 10:00"),
    }),
    "suprimir",
  );
});

Deno.test("empate de minuto exato → REABRE (lean a mostrar, decisão do Caio)", () => {
  assertEquals(
    decidirReaberturaPorSsw({
      ocSswMaisRecente: 49, ocSswMaisRecenteMs: T("25/06/26 10:00"),
      ehRelac, ultimoLancamentoCockpitMs: T("25/06/26 10:00"),
    }),
    "reabrir",
  );
});

Deno.test("SSW mais recente = 54 → SUPRIME (aguardando cliente, nunca reabre por ela)", () => {
  assertEquals(
    decidirReaberturaPorSsw({
      ocSswMaisRecente: 54, ocSswMaisRecenteMs: T("25/06/26 11:00"),
      ehRelac, ultimoLancamentoCockpitMs: T("25/06/26 09:00"),
    }),
    "suprimir",
  );
});

Deno.test("SSW fora do ar / sem oc → INDEFINIDO (retry próximo ciclo, não esconde)", () => {
  assertEquals(
    decidirReaberturaPorSsw({
      ocSswMaisRecente: null, ocSswMaisRecenteMs: null,
      ehRelac, ultimoLancamentoCockpitMs: T("25/06/26 09:00"),
    }),
    "indefinido",
  );
});

Deno.test("extravio: oc 20 relac, nunca lançou pelo Cockpit → REABRE", () => {
  assertEquals(
    decidirReaberturaPorSsw({
      ocSswMaisRecente: 20, ocSswMaisRecenteMs: T("25/06/26 09:00"),
      ehRelac, ultimoLancamentoCockpitMs: null,
    }),
    "reabrir",
  );
});

Deno.test("SSW aponta relac ≠54 mas hora não-parseável → REABRE (lean a mostrar)", () => {
  assertEquals(
    decidirReaberturaPorSsw({
      ocSswMaisRecente: 49, ocSswMaisRecenteMs: null,
      ehRelac, ultimoLancamentoCockpitMs: T("25/06/26 09:00"),
    }),
    "reabrir",
  );
});

// GAP CONHECIDO — NF 346896 (Caio 2026-07-13): havia aqui 3 testes de uma função
// `decidirReaberturaPorOrdemSsw` (decidir pela ORDEM das ocorrências no SSW, não só
// pela hora) que NUNCA foi implementada no fonte — o teste foi commitado na
// regularização (883ff15, "git = prod") SEM a função, quebrando o módulo inteiro
// (import morto) e deixando o INV-023 do /verify-cockpit falhando desde então.
// Reconciliado com o que REALMENTE shipou: `decidirReaberturaPorSsw` (por HORA).
//
// GAP REAL não-corrigido (pré-existente ao 54/59): no SKEW de relógio da NF 346896 —
// SSW mostra oc 19 às 13:13 ACIMA da 56 do Cockpit (13:12), mas o `iniciado_em` do
// lançamento no DB é 13:14 (> 13:13) — a versão por-HORA SUPRIME (deveria REABRIR
// pela ORDEM do SSW). Decisão do Caio se reimplementa a versão por-ordem. Os 2
// cenários anti-loop abaixo a versão por-HORA já cobre (mesmo resultado).

Deno.test("anti-loop: oc de Relacionamento antiga (hora < lançamento) → SUPRIME por hora", () => {
  assertEquals(
    decidirReaberturaPorSsw({
      ocSswMaisRecente: 49, ocSswMaisRecenteMs: T("25/06/26 09:20"),
      ehRelac, ultimoLancamentoCockpitMs: T("25/06/26 09:23"),
    }),
    "suprimir",
  );
});

Deno.test("anti-loop: SSW mais recente NÃO-relacionamento (lançado pelo Cockpit) → SUPRIME", () => {
  assertEquals(
    decidirReaberturaPorSsw({
      ocSswMaisRecente: 56, ocSswMaisRecenteMs: T("25/06/26 09:23"),
      ehRelac, ultimoLancamentoCockpitMs: T("25/06/26 09:23"),
    }),
    "suprimir",
  );
});

// --- passDDevePreservarBannerIaSugestao: Pass D só preserva o banner de
//     recomendação do agente quando a oc do Bastão é PROVADAMENTE anterior, por
//     data, ao lançamento do Cockpit. Mesmo-dia / posterior / divergência real →
//     NÃO preserva (cai no comportamento normal). NF 705764, refino Caio 2026-06-29.
const IA = "ia_sugestao_ocs_padrao";

Deno.test("NF 705764: banner IA é preservado quando Bastão (06-23) é ANTERIOR ao lançamento Cockpit (06-29)", () => {
  const classe = classificarPorData("2026-06-23", "2026-06-29"); // "lag"
  assertEquals(classe, "lag");
  assertEquals(passDDevePreservarBannerIaSugestao(IA, classe), true);
});

Deno.test("banner IA NÃO é preservado quando MESMO DIA (ambíguo por data — pode ser oc nova)", () => {
  const classe = classificarPorData("2026-06-29", "2026-06-29"); // "ambiguo"
  assertEquals(classe, "ambiguo");
  assertEquals(passDDevePreservarBannerIaSugestao(IA, classe), false);
});

Deno.test("banner IA NÃO é preservado quando oc do Bastão é POSTERIOR ao lançamento (divergência real)", () => {
  const classe = classificarPorData("2026-06-30", "2026-06-29"); // "nova"
  assertEquals(classe, "nova");
  assertEquals(passDDevePreservarBannerIaSugestao(IA, classe), false);
});

Deno.test("banner IA NÃO é preservado quando o Cockpit nunca lançou (não há lag a respeitar)", () => {
  const classe = classificarPorData("2026-06-23", null); // "nova"
  assertEquals(passDDevePreservarBannerIaSugestao(IA, classe), false);
});

Deno.test("guard só vale pro banner ia_sugestao — aviso de conflito comum NÃO é preservado nem em lag", () => {
  assertEquals(passDDevePreservarBannerIaSugestao(null, "lag"), false);
  assertEquals(passDDevePreservarBannerIaSugestao("conflito", "lag"), false);
});
