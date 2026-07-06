// Teste da precedência RECUSA PARCIAL (oc=35) sobre a rota de EXTRAVIO da oc=49.
// Caio 2026-07-06, NF 28002 (Larissa). Bug 1: agente sugeria EXTRAVIO_PARCIAL
// quando o contexto real era RECUSA PARCIAL. A oc=35 deve prevalecer.
// Rodar: deno test recusa-parcial-precede-extravio.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  OCS_RECUSA_PARCIAL,
  recusaParcialNoHistorico,
} from "./recusa-por-extravio.ts";

// Histórico MAIS-RECENTE-PRIMEIRO a partir de ordem cronológica (antiga→nova).
function hist(cronologico: number[]) {
  return cronologico.slice().reverse().map((codigo) => ({ codigo }));
}

Deno.test("35 no conjunto de recusa parcial", () => {
  assertEquals(OCS_RECUSA_PARCIAL.has(35), true);
});

// Fixture canônica NF 28002: extravio (6) → recusa parcial (35) → 49.
// Esperado: precedência dispara (retorna a 35) ⇒ decidirOc49 NÃO sugere extravio.
Deno.test("NF 28002: histórico 6 + 35 + 49 → recusa parcial prevalece (retorna a 35)", () => {
  const h = hist([6, 35, 49]);
  const r = recusaParcialNoHistorico(h);
  assertEquals(r?.codigo, 35);
});

Deno.test("histórico 9 + 16 + 35 + 49 (múltiplos extravios) → ainda pega a 35", () => {
  const h = hist([9, 16, 35, 49]);
  assertEquals(recusaParcialNoHistorico(h)?.codigo, 35);
});

// Sem 35 no histórico → precedência NÃO dispara ⇒ rota de extravio segue normal.
Deno.test("extravio puro 6 + 49 (sem 35) → null (deixa rota de extravio rodar)", () => {
  const h = hist([6, 49]);
  assertEquals(recusaParcialNoHistorico(h), null);
});

Deno.test("histórico vazio → null", () => {
  assertEquals(recusaParcialNoHistorico([]), null);
});
