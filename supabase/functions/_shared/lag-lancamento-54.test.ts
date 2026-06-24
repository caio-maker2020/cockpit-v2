// Guard de não-regressão da REGRESSÃO NF 175621/10415 (Caio 2026-06-24): card que
// lançou oc=54 pelo Cockpit voltou pra AGUARDANDO VOCÊ porque o Bastão lagava na
// oc ANTERIOR (49 datada ANTES do lançamento de 54). A oc do Bastão só conta como
// "nova" se for MAIS RECENTE que o lançamento de 54. <= é lag → NÃO rebaixar.
//
// Rodar: deno test supabase/functions/_shared/lag-lancamento-54.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classificarPorData, dataBrtDeTimestamp, ehLagDeLancamento54PorData } from "./lag-lancamento-54.ts";

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
