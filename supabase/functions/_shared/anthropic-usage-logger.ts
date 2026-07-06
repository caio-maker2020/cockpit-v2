// Logger BEST-EFFORT de uso/custo da Anthropic API → tabela anthropic_usage_log.
//
// Espelha a filosofia do agent-runs-logger (Caio 2026-06-10): falha de
// telemetria NUNCA derruba a chamada Anthropic nem o fluxo operacional —
// try/catch interno, nunca propaga.
//
// PRIVACIDADE: grava SOMENTE metadados de uso/custo. NUNCA prompt, conteúdo de
// e-mail, imagem/base64, resposta completa ou PII.
//
// GATING: só grava se a flag ANTHROPIC_USAGE_LOG_ENABLED estiver ligada
// (default OFF). Liga com "1" | "true" | "yes" | "on".
//
// Rodar testes: deno test --allow-env supabase/functions/_shared/anthropic-usage-logger.test.ts

import type { AnthropicUsageRecord } from "./anthropic-client.ts";
import { estimateCostUsd } from "./anthropic-usage-cost.ts";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Lê a flag ANTHROPIC_USAGE_LOG_ENABLED (default OFF). */
export function isUsageLogEnabled(): boolean {
  try {
    const v = (Deno.env.get("ANTHROPIC_USAGE_LOG_ENABLED") ?? "").trim().toLowerCase();
    return TRUTHY.has(v);
  } catch {
    return false;
  }
}

// Estrutura MÍNIMA do client (só `.from(t).insert(row)`). Evita puxar os
// genéricos profundos do SupabaseClient, que estouram TS2589 ("type
// instantiation excessively deep") quando instanciados em vários call sites.
// Qualquer SupabaseClient real é estruturalmente compatível; facilita fake em teste.
interface InsertableClient {
  from(table: string): { insert(row: Record<string, unknown>): unknown };
}

/**
 * Grava 1 linha de uso/custo. Best-effort: se a flag estiver OFF, é no-op;
 * se o INSERT falhar, loga no console e NÃO propaga.
 */
export async function logAnthropicUsage(
  supabase: unknown,
  rec: AnthropicUsageRecord,
): Promise<void> {
  try {
    if (!isUsageLogEnabled()) return;

    // Cast estrutural local: param é `unknown` p/ não instanciar os genéricos
    // profundos do SupabaseClient nos call sites (evita TS2589).
    const client = supabase as InsertableClient;

    const estimated = estimateCostUsd({
      model: rec.model,
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      cacheCreationTokens: rec.cacheCreationTokens,
      cacheReadTokens: rec.cacheReadTokens,
    });

    await client.from("anthropic_usage_log").insert({
      function_name: rec.functionName ?? null,
      agent_name: rec.agentName ?? null,
      card_id: rec.cardId ?? null,
      message_id: rec.messageId ?? null,
      model: rec.model,
      input_tokens: rec.inputTokens,
      output_tokens: rec.outputTokens,
      cache_creation_tokens: rec.cacheCreationTokens,
      cache_read_tokens: rec.cacheReadTokens,
      image_count: rec.imageCount,
      estimated_cost_usd: estimated,
      status: rec.status,
      attempt: rec.attempt,
      request_id: rec.requestId ?? null,
      started_at: rec.startedAt,
      finished_at: rec.finishedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[anthropic-usage-logger] falha best-effort (ignorada):", msg);
  }
}

/**
 * Fábrica de hook `onUsage` pro createAnthropicClient. `base` traz
 * function_name/agent_name fixos da função; cada attempt já vem com
 * card_id/message_id/tokens do wrapper. Retorna a Promise do INSERT pro
 * wrapper poder aguardar (sem nunca lançar).
 */
export function makeUsageRecorder(
  supabase: unknown,
  base: { functionName?: string; agentName?: string },
): (rec: AnthropicUsageRecord) => Promise<void> {
  return (rec) =>
    logAnthropicUsage(supabase, {
      ...rec,
      functionName: rec.functionName ?? base.functionName,
      agentName: rec.agentName ?? base.agentName,
    });
}
