// Testes da decisão pura `decidirDestinoExtravio` (REGRA INVIOLÁVEL da aba
// EXTRAVIOS: 6/9/16 fica; qualquer outra oc SAI roteada pela responsabilidade).
// Rodar: deno test supabase/functions/_shared/extravio-routing.test.ts
//
// Sem SUPABASE_URL no ambiente, bastao-rules cai no FALLBACK_HARDCODED de
// OCORRENCIAS_DE_RELACIONAMENTO = {3,8,10,11,17,19,20,23,26,28,35,43,49,54,57}.
// Os casos âncora (20=relac, 33=ressarcimento/fora, 1/30/32=finalizadora) batem
// com o fallback, então o teste é determinístico offline.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decidirDestinoExtravio, EXTRAVIO_OCS } from "./extravio-routing.ts";

Deno.test("EXTRAVIO_OCS é exatamente {6,9,16}", () => {
  assertEquals([...EXTRAVIO_OCS].sort((a, b) => a - b), [6, 9, 16]);
});

Deno.test("oc de extravio (6/9/16) FICA na aba EXTRAVIOS", () => {
  for (const oc of [6, 9, 16]) {
    const d = decidirDestinoExtravio(oc, false);
    assertEquals(d.decisao, "extravio", `oc ${oc}`);
    assertEquals(d.state, "EXTRAVIO_MONITORADO", `oc ${oc}`);
    assertEquals(d.lock, false, `oc ${oc}`);
  }
});

Deno.test("oc 20 (extravio localizado = Relacionamento) com regra → AGUARDANDO VOCÊ + lock", () => {
  const d = decidirDestinoExtravio(20, true);
  assertEquals(d.decisao, "aguardando_voce");
  assertEquals(d.state, "AGUARDANDO_VALIDACAO_HUMANA");
  assertEquals(d.lock, true);
});

Deno.test("oc de relacionamento SEM regra (ex: 8) → AGUARDANDO_AGENTE sem lock", () => {
  const d = decidirDestinoExtravio(8, false);
  assertEquals(d.decisao, "aguardando_voce");
  assertEquals(d.state, "AGUARDANDO_AGENTE");
  assertEquals(d.lock, false);
});

Deno.test("oc 33 (reversão de perdas = Ressarcimento) → TRANSFERIDO", () => {
  const d = decidirDestinoExtravio(33, false);
  assertEquals(d.decisao, "transferido");
  assertEquals(d.state, "TRANSFERIDO");
  assertEquals(d.lock, false);
});

Deno.test("ocs finalizadoras (1/30/32) → RESOLVIDO", () => {
  for (const oc of [1, 30, 32]) {
    const d = decidirDestinoExtravio(oc, false);
    assertEquals(d.decisao, "resolvido", `oc ${oc}`);
    assertEquals(d.state, "RESOLVIDO", `oc ${oc}`);
    assertEquals(d.lock, false, `oc ${oc}`);
  }
});

Deno.test("oc 54 (Cliente) → AGUARDANDO_CLIENTE sem lock (manter_state)", () => {
  // temRegra true ou false não muda: stateFinalAposBastao trata 54 antes da regra.
  for (const temRegra of [true, false]) {
    const d = decidirDestinoExtravio(54, temRegra);
    assertEquals(d.decisao, "aguardando_voce");
    assertEquals(d.state, "AGUARDANDO_CLIENTE");
    assertEquals(d.lock, false);
  }
});

Deno.test("oc fora de qualquer escopo (ex: 5 = Operação) → TRANSFERIDO", () => {
  const d = decidirDestinoExtravio(5, false);
  assertEquals(d.decisao, "transferido");
  assertEquals(d.state, "TRANSFERIDO");
});
