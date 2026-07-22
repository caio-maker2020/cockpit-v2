// Guard anti-regressão do fix WORKER_RESOURCE_LIMIT do gmail-poll-inbox
// (2026-07-22, NF 1504049 COMERCIAL AUTOMOTIVA). Se estes helpers sumirem ou
// regredirem, o poller volta ao padrão 1-query-por-mensagem que derrubava o
// worker (546 em ~toda rodada) e deixava respostas de cliente invisíveis.
//
// Rodar: deno test supabase/functions/_shared/gmail-poll-batch.test.ts

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapaMaisRecentePorChave, particionarEmChunks } from "./gmail-poll-batch.ts";

Deno.test("particionarEmChunks: particiona respeitando o tamanho", () => {
  assertEquals(particionarEmChunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(particionarEmChunks([], 100), []);
});

Deno.test("particionarEmChunks: rejeita tamanho inválido", () => {
  assertThrows(() => particionarEmChunks([1], 0));
});

const rows = [
  { tid: "t1", card: "velho", ts: "2026-07-01T00:00:00Z" },
  { tid: "t1", card: "novo", ts: "2026-07-20T00:00:00Z" },
  { tid: "t2", card: "unico", ts: "2026-07-10T00:00:00Z" },
  { tid: null, card: "sem-chave", ts: "2026-07-21T00:00:00Z" },
  { tid: "t3", card: null, ts: "2026-07-21T00:00:00Z" },
];

Deno.test("mapaMaisRecentePorChave: mais recente vence, nulos ignorados", () => {
  const m = mapaMaisRecentePorChave(rows, (r) => r.tid, (r) => r.card, (r) => r.ts);
  assertEquals(m.get("t1"), "novo");
  assertEquals(m.get("t2"), "unico");
  assertEquals(m.size, 2);
});

Deno.test("mapaMaisRecentePorChave: não muta a entrada e aceita ts nulo", () => {
  const entrada = [{ tid: "a", card: "x", ts: null as string | null }];
  const m = mapaMaisRecentePorChave(entrada, (r) => r.tid, (r) => r.card, (r) => r.ts);
  assertEquals(m.get("a"), "x");
  assertEquals(entrada.length, 1);
});
