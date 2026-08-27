// Guard INV-118 (Caio 27/08, NF 660746): card reaberto de terminal com
// leitura "nada a fazer" volta sozinho; qualquer sinal de trabalho mantém.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ehRespostaSemAcao, type LeituraPraDevolucao } from "./resposta-sem-acao.ts";

const base: LeituraPraDevolucao = {
  oc_sugerida: 55, pendencias: [], sugere_oc33_solo: false,
  sugere_combo_33_44: false, sugere_combo_44_59: false,
  leitura_parcial: false, leitura_degradada: false, tipo_destaque: null,
};

Deno.test("ÂNCORA 660746: cliente mandou romaneio, IA diz '55 reflete o acordo' (55==última 55) → sem ação", () => {
  assertEquals(ehRespostaSemAcao(base, 55), true);
});

Deno.test("destaque 'aguardar' → sem ação (devolve)", () => {
  assertEquals(ehRespostaSemAcao({ ...base, oc_sugerida: null, tipo_destaque: "aguardar" }, 55), true);
});

Deno.test("oc sugerida DIFERENTE da última do Cockpit → tem ação (fica aberto)", () => {
  assertEquals(ehRespostaSemAcao({ ...base, oc_sugerida: 21 }, 55), false);
});

Deno.test("pendências na resposta → fica aberto", () => {
  assertEquals(ehRespostaSemAcao({ ...base, pendencias: ["informar endereço"] }, 55), false);
});

Deno.test("qualquer combo/33 → fica aberto", () => {
  assertEquals(ehRespostaSemAcao({ ...base, sugere_oc33_solo: true }, 55), false);
  assertEquals(ehRespostaSemAcao({ ...base, sugere_combo_33_44: true }, 55), false);
  assertEquals(ehRespostaSemAcao({ ...base, sugere_combo_44_59: true }, 55), false);
});

Deno.test("leitura parcial/degradada → fica aberto (olho humano)", () => {
  assertEquals(ehRespostaSemAcao({ ...base, leitura_parcial: true }, 55), false);
  assertEquals(ehRespostaSemAcao({ ...base, leitura_degradada: true }, 55), false);
});

Deno.test("sem lançamento do Cockpit no card (ultimaOc null) e sem 'aguardar' → fica aberto", () => {
  assertEquals(ehRespostaSemAcao(base, null), false);
});
