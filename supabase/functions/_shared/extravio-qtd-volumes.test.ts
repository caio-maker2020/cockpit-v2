// Congelamento do parser da instrução de extravio (ADR 0025, F4).
//
// Este parser existe desde o ADR 0012 e NUNCA teve teste. Ele decide, na prática,
// se um extravio é tratado como total ou parcial — e a partir do ADR 0025 ele
// também decide se uma oc 55 automática sai ou não. Sem rede aqui, qualquer
// ajuste futuro de regex é uma aposta.
//
// Os casos vieram da medição F0 (2026-09-03): instruções REAIS dos 4 CNPJs do
// escopo, janela de 180 dias.
//
// Rodar: deno test supabase/functions/_shared/extravio-qtd-volumes.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extrairQtdVolumes } from "./extravio-qtd-volumes.ts";

Deno.test("palavra TOTAL em todas as variações que a unidade escreve", () => {
  assertEquals(extrairQtdVolumes("TOTAL"), { total: true });
  assertEquals(extrairQtdVolumes("FALTA TOTAL (SSWMOBILE)"), { total: true });
  assertEquals(extrairQtdVolumes("EXTRAVIO TOTAL"), { total: true });
  assertEquals(extrairQtdVolumes("PERDA TOTAL"), { total: true });
  assertEquals(extrairQtdVolumes("extravio total"), { total: true }); // case-insensitive
});

Deno.test("número solto = quantidade faltante (formato mais comum na base)", () => {
  assertEquals(extrairQtdVolumes("2"), { qtd: 2 });
  assertEquals(extrairQtdVolumes("9"), { qtd: 9 });
  assertEquals(extrairQtdVolumes("01"), { qtd: 1 });
  assertEquals(extrairQtdVolumes("3."), { qtd: 3 });
});

Deno.test("ruído do SSWMOBILE e do GPS é removido antes de ler", () => {
  assertEquals(extrairQtdVolumes("2 (SSWMOBILE)"), { qtd: 2 });
  assertEquals(extrairQtdVolumes("7 (SSWMOBILE)"), { qtd: 7 });
  assertEquals(extrairQtdVolumes("3 GPS (-19.9,-43.9)"), { qtd: 3 });
});

Deno.test("fraseado FALTA/FALTAM + VL/VOLUME", () => {
  assertEquals(extrairQtdVolumes("FALTA 1 VL (SSWMOBILE)"), { qtd: 1 });
  assertEquals(extrairQtdVolumes("FALTAM 2 VL (SSWMOBILE)"), { qtd: 2 });
  assertEquals(extrairQtdVolumes("FALTA 3"), { qtd: 3 });
  assertEquals(extrairQtdVolumes("QTD 4"), { qtd: 4 });
  assertEquals(extrairQtdVolumes("5 VOLUMES"), { qtd: 5 });
});

Deno.test("vazio / nulo / lixo não viram quantidade", () => {
  assertEquals(extrairQtdVolumes(""), null);
  assertEquals(extrairQtdVolumes(null), null);
  assertEquals(extrairQtdVolumes(undefined), null);
  assertEquals(extrairQtdVolumes("   "), null);
  assertEquals(extrairQtdVolumes("EXTRAVIO NA TRANSFERENCIA"), null);
  assertEquals(extrairQtdVolumes("(SSWMOBILE)"), null);
});

Deno.test("LIMITAÇÕES CONHECIDAS — congeladas de propósito, não são bugs a corrigir às cegas", () => {
  // Estes três aparecem na base real e o parser NÃO os lê. Ficam aqui para que
  // (a) ninguém "conserte" sem medir, e (b) se alguém melhorar a regex, o teste
  // falhe e a pessoa seja obrigada a revisar o ADR 0025 (D3 depende disto).
  //
  // Consequência hoje: null → analisarExtravio trata como TOTAL (conservador).
  // Dentro da whitelist do ADR 0025, null → PARCIAL (D3). Os três casos abaixo
  // SÃO parciais de verdade, então o D3 acerta e o default global erra.
  assertEquals(extrairQtdVolumes("1 V"), null); // NF 192292, NF de 6 volumes
  assertEquals(extrairQtdVolumes("F1 (SSWMOBILE)"), null); // NF 114614, NF de 7 volumes
  assertEquals(
    extrairQtdVolumes("1 PROVAVELMENTE ERRO NO CARREGAMENTO OS 2 ESTAVA AQUI NA SEXTA"),
    null,
  ); // NF 115449, NF de 2 volumes
});

Deno.test("guarda-corpo numérico: 0 e >=1000 não passam", () => {
  assertEquals(extrairQtdVolumes("0"), null);
  assertEquals(extrairQtdVolumes("FALTA 0"), null);
  assertEquals(extrairQtdVolumes("1000"), null); // 4 dígitos não casam \d{1,3}
});
