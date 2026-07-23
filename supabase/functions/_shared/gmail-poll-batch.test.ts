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

// =============================================================================
// INV-043 (Caio 2026-07-23, NF 389040 DUILIO): rodízio justo entre caixas.
// O embed do PostgREST volta como OBJETO; o código lia [0] como array →
// ordenação virava empate universal → KAROLINE+JULIA monopolizavam o budget e
// 7 caixas ficavam sem leitura (43 capturas/dia do DUILIO → 1).
// =============================================================================

import { lastPollAtDoEmbed, ordenarPorDefasagem } from "./gmail-poll-batch.ts";

Deno.test("lastPollAtDoEmbed: OBJETO (shape real do PostgREST 1-pra-1) — o bug da NF 389040", () => {
  assertEquals(lastPollAtDoEmbed({ last_poll_at: "2026-06-22T17:51:00Z" }), "2026-06-22T17:51:00Z");
});

Deno.test("lastPollAtDoEmbed: array (defensivo), vazio e null", () => {
  assertEquals(lastPollAtDoEmbed([{ last_poll_at: "2026-07-23T10:00:00Z" }]), "2026-07-23T10:00:00Z");
  assertEquals(lastPollAtDoEmbed([]), null);
  assertEquals(lastPollAtDoEmbed(null), null);
  assertEquals(lastPollAtDoEmbed(undefined), null);
});

Deno.test("ordenarPorDefasagem: nunca-lida primeiro, depois mais antiga (DUILIO antes de JULIA)", () => {
  const ops = [
    { nome: "JULIA", emb: { last_poll_at: "2026-07-23T15:12:00Z" } },
    { nome: "DUILIO", emb: { last_poll_at: "2026-06-22T17:51:00Z" } },
    { nome: "NOVA", emb: null },
    { nome: "COCKPIT", emb: { last_poll_at: "2026-07-23T11:26:00Z" } },
  ];
  const ordenados = ordenarPorDefasagem(ops, (o) => lastPollAtDoEmbed(o.emb)).map((o) => o.nome);
  assertEquals(ordenados, ["NOVA", "DUILIO", "COCKPIT", "JULIA"]);
});

// =============================================================================
// Causa-2 (Matheus 2026-07-23): memória de avaliação por mensagem. Se estes
// helpers regredirem, o poller volta a re-fetchar no Gmail toda msg não-casada
// a cada rodada e o backlog (sac 436, julia 427, larissa 410...) nunca drena.
// =============================================================================

import {
  mapaMemoAvaliacao,
  setDeGmailMessageIds,
} from "./gmail-poll-batch.ts";

Deno.test("mapaMemoAvaliacao: reduz linhas do memo, normaliza nf/domínio/flag", () => {
  const m = mapaMemoAvaliacao([
    { gmail_message_id: "a", nf_extraida: "1008919", dominio_remetente: "prati.com.br", scan_divergente_enfileirado: true },
    { gmail_message_id: "b", nf_extraida: null, dominio_remetente: null, scan_divergente_enfileirado: null },
    { gmail_message_id: null, nf_extraida: "x", dominio_remetente: "y", scan_divergente_enfileirado: true },
  ]);
  assertEquals(m.get("a"), { nf: "1008919", dominio: "prati.com.br", scanEnfileirado: true });
  // null vira false (defensivo) e nf/domínio null preservados (personal email)
  assertEquals(m.get("b"), { nf: null, dominio: null, scanEnfileirado: false });
  // id nulo é ignorado
  assertEquals(m.size, 2);
});

Deno.test("setDeGmailMessageIds: coleta ids não-nulos", () => {
  const s = setDeGmailMessageIds([
    { gmail_message_id: "m1" },
    { gmail_message_id: null },
    { gmail_message_id: "m2" },
    { gmail_message_id: "" },
  ]);
  assertEquals(s.has("m1"), true);
  assertEquals(s.has("m2"), true);
  assertEquals(s.size, 2);
});
