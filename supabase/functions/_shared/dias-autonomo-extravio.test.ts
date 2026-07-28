// Guard — limiar do agente autônomo de extravio (Duílio 2026-07-28, NF/carteira
// FELIPE + cliente PRATI). Se a precedência regredir, o robô lança oc 49 no dia
// errado — cedo demais (rajada) ou tarde demais (perde o SLA pedido).
// Rodar: deno test supabase/functions/_shared/dias-autonomo-extravio.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_DIAS_AUTONOMO_EXTRAVIO,
  elegivelLancamento49Autonomo,
  resolverDiasAutonomoExtravio,
} from "./dias-autonomo-extravio.ts";

Deno.test("precedência: cliente vence operador vence default(4)", () => {
  // cliente override sempre ganha (PRATI=2 mesmo se o operador fosse 4)
  assertEquals(resolverDiasAutonomoExtravio(4, 2), 2);
  assertEquals(resolverDiasAutonomoExtravio(2, 5), 5);
  // sem cliente → operador (FELIPE=2)
  assertEquals(resolverDiasAutonomoExtravio(2, null), 2);
  assertEquals(resolverDiasAutonomoExtravio(2, undefined), 2);
  // sem cliente e sem operador explícito → default 4 (resto do time)
  assertEquals(resolverDiasAutonomoExtravio(null, null), DEFAULT_DIAS_AUTONOMO_EXTRAVIO);
  assertEquals(resolverDiasAutonomoExtravio(undefined, undefined), 4);
  // só cliente
  assertEquals(resolverDiasAutonomoExtravio(null, 2), 2);
});

Deno.test("ÂNCORA FELIPE (operador=2): card em D2 já é elegível; D1 não", () => {
  const limiar = resolverDiasAutonomoExtravio(2, null); // 2
  assertEquals(elegivelLancamento49Autonomo(2, limiar), true);
  assertEquals(elegivelLancamento49Autonomo(3, limiar), true);
  assertEquals(elegivelLancamento49Autonomo(1, limiar), false);
});

Deno.test("ÂNCORA PRATI (cliente=2, operador LARISSA=4): override do cliente manda → D2 elegível", () => {
  const limiar = resolverDiasAutonomoExtravio(4, 2); // cliente vence = 2
  assertEquals(elegivelLancamento49Autonomo(2, limiar), true);
});

Deno.test("RESTO DO TIME (default 4): D2/D3 NÃO elegíveis; D4 sim (comportamento antigo preservado)", () => {
  const limiar = resolverDiasAutonomoExtravio(4, null); // 4
  assertEquals(elegivelLancamento49Autonomo(2, limiar), false);
  assertEquals(elegivelLancamento49Autonomo(3, limiar), false);
  assertEquals(elegivelLancamento49Autonomo(4, limiar), true);
  assertEquals(elegivelLancamento49Autonomo(6, limiar), true);
});

Deno.test("dias_uteis null/undefined nunca é elegível", () => {
  assertEquals(elegivelLancamento49Autonomo(null, 2), false);
  assertEquals(elegivelLancamento49Autonomo(undefined, 4), false);
});
