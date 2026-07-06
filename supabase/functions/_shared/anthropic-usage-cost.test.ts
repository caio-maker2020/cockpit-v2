// Testes do cálculo de custo estimado de chamadas Anthropic.
// Rodar: deno test supabase/functions/_shared/anthropic-usage-cost.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { estimateCostUsd, pricingForModel } from "./anthropic-usage-cost.ts";

Deno.test("Sonnet: 1M in * $3 + 1M out * $15 = $18", () => {
  assertEquals(
    estimateCostUsd({ model: "claude-sonnet-4-6", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    18,
  );
});

Deno.test("Haiku é mais barato que Sonnet pro MESMO uso", () => {
  const h = estimateCostUsd({ model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 500 })!;
  const s = estimateCostUsd({ model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 500 })!;
  assertEquals(h < s, true);
});

Deno.test("inclui cache: 1M write(5m) * $3.75 + 1M read * $0.30 = $4.05", () => {
  assertEquals(
    estimateCostUsd({
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    }),
    4.05,
  );
});

Deno.test("modelo desconhecido → null (não inventa custo)", () => {
  assertEquals(estimateCostUsd({ model: "gpt-4o", inputTokens: 1000, outputTokens: 1000 }), null);
});

Deno.test("modelo com sufixo de versão casa por prefixo", () => {
  assertEquals(pricingForModel("claude-sonnet-4-6-20260101")?.input, 3);
});

Deno.test("zero tokens → custo 0 (não null)", () => {
  assertEquals(estimateCostUsd({ model: "claude-haiku-4-5", inputTokens: 0, outputTokens: 0 }), 0);
});
