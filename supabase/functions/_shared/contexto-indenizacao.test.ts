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
