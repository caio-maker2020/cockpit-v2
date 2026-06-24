// Testes do detector "recusa originada de extravio ainda não notificada".
// Caio 2026-06-24 (NF 148558). Rodar: deno test recusa-por-extravio.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recusaOriginadaDeExtravioNaoNotificada } from "./recusa-por-extravio.ts";

// Helper: monta histórico mais-recente-primeiro a partir de uma lista de ocs
// na ORDEM CRONOLÓGICA (antiga→nova) e inverte, pra ler como o caso real.
function hist(cronologico: number[]) {
  return cronologico.map((codigo) => ({ codigo })).reverse();
}

Deno.test("NF 148558: oc=6 → oc=10, sem 54/49/20 depois → dispara (retorna o extravio)", () => {
  const h = hist([6, 10]); // extravio depois recusa
  const r = recusaOriginadaDeExtravioNaoNotificada(h);
  assertEquals(r?.codigo, 6);
});

Deno.test("oc=9 e oc=16 também contam como extravio", () => {
  assertEquals(recusaOriginadaDeExtravioNaoNotificada(hist([9, 35]))?.codigo, 9);
  assertEquals(recusaOriginadaDeExtravioNaoNotificada(hist([16, 19]))?.codigo, 16);
});

Deno.test("já notificou: oc=54 lançada DEPOIS do extravio → NÃO dispara", () => {
  const h = hist([6, 10, 54]); // operador já notificou (54 após extravio)
  assertEquals(recusaOriginadaDeExtravioNaoNotificada(h), null);
});

Deno.test("oc=49 depois do extravio (tratativa relacionamento) → NÃO dispara", () => {
  assertEquals(recusaOriginadaDeExtravioNaoNotificada(hist([6, 49, 10])), null);
});

Deno.test("oc=20 depois do extravio → NÃO dispara", () => {
  assertEquals(recusaOriginadaDeExtravioNaoNotificada(hist([6, 20, 10])), null);
});

Deno.test("sem extravio no histórico → NÃO dispara", () => {
  assertEquals(recusaOriginadaDeExtravioNaoNotificada(hist([1, 10, 35])), null);
});

Deno.test("54 ANTES do extravio não conta (só vale depois) → dispara", () => {
  // 54 antigo, depois novo extravio, depois recusa, sem 54/49/20 após o extravio
  const h = hist([54, 6, 10]);
  assertEquals(recusaOriginadaDeExtravioNaoNotificada(h)?.codigo, 6);
});

Deno.test("usa o extravio MAIS RECENTE: 54 entre dois extravios → o 2º extravio não tem 54 depois → dispara", () => {
  // cronológico: extravio(6) → 54 → extravio(6) → recusa(10)
  const h = hist([6, 54, 6, 10]);
  assertEquals(recusaOriginadaDeExtravioNaoNotificada(h)?.codigo, 6);
});

Deno.test("histórico vazio → null", () => {
  assertEquals(recusaOriginadaDeExtravioNaoNotificada([]), null);
});

Deno.test("ignora codigo null sem quebrar", () => {
  const h = [{ codigo: null }, { codigo: 10 }, { codigo: 6 }];
  assertEquals(recusaOriginadaDeExtravioNaoNotificada(h)?.codigo, 6);
});
