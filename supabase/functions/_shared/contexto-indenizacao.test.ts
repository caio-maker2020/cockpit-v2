// Guard INV-047 — NF 1100040 (LARISSA, 2026-07-23): extravio parcial com
// trilha de indenização destaca 59, não 54.
// Rodar: deno test supabase/functions/_shared/contexto-indenizacao.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { temContextoIndenizacao } from "./contexto-indenizacao.ts";

Deno.test("ÂNCORA NF 1100040: oc 59 no histórico → contexto de indenização", () => {
  const historico = [{ codigo: 14 }, { codigo: 19 }, { codigo: 59 }, { codigo: 46 }, { codigo: 49 }];
  assertEquals(temContextoIndenizacao(historico, "AG DESCRICAO E VALOR"), true);
});

Deno.test("instrução com ROMANEIO → contexto de indenização (mesmo sem 59 no histórico)", () => {
  assertEquals(temContextoIndenizacao([{ codigo: 49 }], "AGUARDANDO ROMANEIO ASSINADO"), true);
});

Deno.test("anti-falso-positivo: parcial comum NÃO vira indenização ('valor'/'descrição' sozinhos não contam)", () => {
  assertEquals(temContextoIndenizacao([{ codigo: 6 }, { codigo: 49 }], "EXTRAVIO 2 VOLUMES VALOR R$ 150"), false);
  assertEquals(temContextoIndenizacao([], null), false);
  assertEquals(temContextoIndenizacao(null, "AG DESCRICAO E VALOR"), false);
});

// =============================================================================
// 2ª regra (Caio 23/07): relançamento 59 SEM e-mail — cadeia 49 ← 46 ← 59.
// =============================================================================

import { ehRelancamento59SemEmail } from "./contexto-indenizacao.ts";

Deno.test("ÂNCORA NF 1100040: 49←46←59 (mais recente primeiro) → RELANÇAR 59 SEM e-mail", () => {
  const hist = [{ codigo: 49 }, { codigo: 46 }, { codigo: 59 }, { codigo: 19 }, { codigo: 14 }];
  assertEquals(ehRelancamento59SemEmail(hist), true);
});

Deno.test("variações válidas: múltiplas 49 no topo e múltiplas 46 no meio", () => {
  assertEquals(ehRelancamento59SemEmail([{ codigo: 49 }, { codigo: 49 }, { codigo: 46 }, { codigo: 46 }, { codigo: 59 }]), true);
  assertEquals(ehRelancamento59SemEmail([{ codigo: 49 }, { codigo: 59 }]), true); // 46 é opcional
});

Deno.test("cadeia quebrada → NÃO é recobrança (segue 59+email normal)", () => {
  assertEquals(ehRelancamento59SemEmail([{ codigo: 49 }, { codigo: 20 }, { codigo: 59 }]), false); // oc no meio
  assertEquals(ehRelancamento59SemEmail([{ codigo: 49 }, { codigo: 46 }, { codigo: 54 }]), false); // elo não é 59
  assertEquals(ehRelancamento59SemEmail([{ codigo: 46 }, { codigo: 59 }]), false); // topo não é 49
  assertEquals(ehRelancamento59SemEmail([]), false);
  assertEquals(ehRelancamento59SemEmail(null), false);
});
