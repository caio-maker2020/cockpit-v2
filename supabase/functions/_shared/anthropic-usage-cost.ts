// Cálculo de custo estimado de chamadas Anthropic (USD). Função PURA, testável.
//
// Preço por milhão de tokens (MTok), fonte skill claude-api (cache 2026-06-04).
// É ESTIMATIVA: o source-of-truth pra recomputar é a tabela `anthropic_pricing`
// (mig 280). cache_write usa o TTL de 5min (1.25x do input). Hoje cache_* = 0
// (sem prompt caching — decisão Caio 2026-06-29).
//
// Rodar testes: deno test supabase/functions/_shared/anthropic-usage-cost.test.ts

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
}

export const ANTHROPIC_PRICING_USD_PER_MTOK: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.30, cacheWrite5m: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.10, cacheWrite5m: 1.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.50, cacheWrite5m: 6.25 },
};

export interface UsageForCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

/** Casa exato ou por prefixo (a API pode devolver o id com sufixo de versão). */
export function pricingForModel(model: string): ModelPricing | null {
  const exact = ANTHROPIC_PRICING_USD_PER_MTOK[model];
  if (exact) return exact;
  for (const key of Object.keys(ANTHROPIC_PRICING_USD_PER_MTOK)) {
    if (model.startsWith(key)) return ANTHROPIC_PRICING_USD_PER_MTOK[key]!;
  }
  return null;
}

/** Custo estimado em USD. `null` se o modelo não estiver na tabela (não inventa). */
export function estimateCostUsd(u: UsageForCost): number | null {
  const p = pricingForModel(u.model);
  if (!p) return null;
  const cacheCreation = u.cacheCreationTokens ?? 0;
  const cacheRead = u.cacheReadTokens ?? 0;
  const usd =
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      cacheCreation * p.cacheWrite5m +
      cacheRead * p.cacheRead) / 1_000_000;
  // 6 casas decimais (numeric(12,6) na tabela)
  return Math.round(usd * 1_000_000) / 1_000_000;
}
