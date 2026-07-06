// Testes do logger best-effort de uso/custo Anthropic.
// Garante: (1) flag OFF não insere; (2) flag ON insere 1 linha SÓ com metadados
// (sem prompt/conteúdo); (3) INSERT que lança NÃO propaga (best-effort).
// Rodar: deno test --allow-env supabase/functions/_shared/anthropic-usage-logger.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isUsageLogEnabled, logAnthropicUsage } from "./anthropic-usage-logger.ts";
import type { AnthropicUsageRecord } from "./anthropic-client.ts";

function rec(over: Partial<AnthropicUsageRecord> = {}): AnthropicUsageRecord {
  return {
    functionName: "triador",
    agentName: "triador",
    cardId: undefined,
    messageId: "msg-1",
    model: "claude-sonnet-4-6",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    imageCount: 0,
    requestId: "req_1",
    stopReason: "end_turn",
    status: "success",
    attempt: 1,
    startedAt: "2026-06-29T00:00:00Z",
    finishedAt: "2026-06-29T00:00:01Z",
    ...over,
  };
}

// deno-lint-ignore no-explicit-any
function fakeSupabase(onInsert: (table: string, row: Record<string, unknown>) => void): any {
  return {
    from(table: string) {
      return { insert: (row: Record<string, unknown>) => Promise.resolve(onInsert(table, row)) };
    },
  };
}

Deno.test("flag OFF → não insere nada", async () => {
  Deno.env.delete("ANTHROPIC_USAGE_LOG_ENABLED");
  let called = false;
  await logAnthropicUsage(fakeSupabase(() => { called = true; }), rec());
  assertEquals(called, false);
  assertEquals(isUsageLogEnabled(), false);
});

Deno.test("flag ON → insere 1 linha com custo e SEM conteúdo de prompt", async () => {
  Deno.env.set("ANTHROPIC_USAGE_LOG_ENABLED", "true");
  let table: string | null = null;
  let row: Record<string, unknown> | null = null;
  await logAnthropicUsage(fakeSupabase((t, r) => { table = t; row = r; }), rec());
  Deno.env.delete("ANTHROPIC_USAGE_LOG_ENABLED");

  assertEquals(table, "anthropic_usage_log");
  assert(row !== null);
  const r = row as Record<string, unknown>;
  assertEquals(r.function_name, "triador");
  assertEquals(r.message_id, "msg-1");
  assertEquals(r.input_tokens, 100);
  assertEquals(r.image_count, 0);
  assertEquals(r.attempt, 1);
  assertEquals(typeof r.estimated_cost_usd, "number");
  // privacidade: nenhum campo de conteúdo
  for (const proibido of ["prompt", "messages", "system", "text", "content", "raw", "email"]) {
    assertEquals(proibido in r, false, `não pode gravar '${proibido}'`);
  }
});

Deno.test("retry (attempt=2) e status=error são persistidos como vieram", async () => {
  Deno.env.set("ANTHROPIC_USAGE_LOG_ENABLED", "true");
  let row: Record<string, unknown> | null = null;
  await logAnthropicUsage(
    fakeSupabase((_t, r) => { row = r; }),
    rec({ attempt: 2, status: "error", inputTokens: 0, outputTokens: 0, requestId: null }),
  );
  Deno.env.delete("ANTHROPIC_USAGE_LOG_ENABLED");
  const r = row as unknown as Record<string, unknown>;
  assertEquals(r.attempt, 2);
  assertEquals(r.status, "error");
  assertEquals(r.input_tokens, 0);
  assertEquals(r.request_id, null);
});

Deno.test("INSERT que lança → NÃO propaga (best-effort)", async () => {
  Deno.env.set("ANTHROPIC_USAGE_LOG_ENABLED", "true");
  let threw = false;
  try {
    await logAnthropicUsage(fakeSupabase(() => { throw new Error("db down"); }), rec());
  } catch {
    threw = true;
  }
  Deno.env.delete("ANTHROPIC_USAGE_LOG_ENABLED");
  assertEquals(threw, false);
});
