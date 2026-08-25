// Guard da identidade do trilho de veto (plano 25/08, etapa A):
// (a) nomes de evento são contrato congelado — Auditoria/front/gatilhos
//     filtram por string literal;
// (b) hash da proposta é estável por VALOR e sensível a QUALQUER mutação
//     (risco 23: payload mudado durante a janela nunca executa às cegas).
// Rodar: deno test supabase/functions/_shared/acao-autonoma-veto.test.ts

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACOES_ONDA_1,
  EVENTO_AGENDADA,
  EVENTO_CANCELADA_OPERADOR,
  EVENTO_DEVOLVIDA,
  EVENTO_EDITADA,
  EVENTO_EXPIRADA,
  EVENTO_SUBSTITUIDA,
  FLAG_VETO,
  hashDaProposta,
  JANELA_VETO_MINUTOS_UTEIS,
  TIPO_EXECUTAR_ACAO_AUTONOMA,
  TTL_EXECUCAO_ATRASADA_MIN,
} from "./acao-autonoma-veto.ts";

Deno.test("contrato congelado: nomes de evento, tipo, flag e janelas", () => {
  assertEquals(TIPO_EXECUTAR_ACAO_AUTONOMA, "executar_acao_autonoma");
  assertEquals(FLAG_VETO, "acao_autonoma_veto_enabled");
  assertEquals(JANELA_VETO_MINUTOS_UTEIS, 60);
  assertEquals(TTL_EXECUCAO_ATRASADA_MIN, 30);
  assertEquals(EVENTO_AGENDADA, "AcaoAutonomaAgendada");
  assertEquals(EVENTO_SUBSTITUIDA, "AcaoAutonomaSubstituida");
  assertEquals(EVENTO_EDITADA, "AcaoAutonomaEditadaPeloOperador");
  assertEquals(EVENTO_CANCELADA_OPERADOR, "AcaoAutonomaCanceladaPeloOperador");
  assertEquals(EVENTO_DEVOLVIDA, "AcaoAutonomaDevolvidaProHumano");
  assertEquals(EVENTO_EXPIRADA, "AcaoAutonomaExpirada");
});

Deno.test("onda 1 = exatamente 21/55 e 54/59 (com e sem e-mail) — 44/56/41 FORA", () => {
  assertEquals([...ACOES_ONDA_1].sort(), [
    "lancar_oc_e_enviar_email:54",
    "lancar_oc_e_enviar_email:59",
    "lancar_ocorrencia:21",
    "lancar_ocorrencia:54",
    "lancar_ocorrencia:55",
    "lancar_ocorrencia:59",
  ]);
  assertEquals(ACOES_ONDA_1.has("lancar_oc_e_enviar_email:44"), false);
  assertEquals(ACOES_ONDA_1.has("lancar_ocorrencia:56"), false);
  assertEquals(ACOES_ONDA_1.has("lancar_ocorrencia:41"), false);
});

Deno.test("hash estável por valor: ordem de chaves não muda o hash", () => {
  const a = { tool: "lancar_ocorrencia", args: { codigo_ssw: 21, motivo: "liberada" } };
  const b = { args: { motivo: "liberada", codigo_ssw: 21 }, tool: "lancar_ocorrencia" };
  assertEquals(hashDaProposta(a), hashDaProposta(b));
});

Deno.test("hash sensível a mutação: qualquer campo alterado muda o hash", () => {
  const base = { tool: "lancar_ocorrencia", args: { codigo_ssw: 21, texto: "abc" } };
  assertNotEquals(hashDaProposta(base), hashDaProposta({ ...base, args: { ...base.args, texto: "abd" } }));
  assertNotEquals(hashDaProposta(base), hashDaProposta({ ...base, args: { ...base.args, codigo_ssw: 54 } }));
  assertNotEquals(hashDaProposta(base), hashDaProposta({ ...base, tool: "lancar_oc_e_enviar_email" }));
});

Deno.test("hash lida com null/arrays/aninhamento sem explodir", () => {
  assertEquals(typeof hashDaProposta(null), "string");
  assertEquals(hashDaProposta([1, 2, { x: null }]), hashDaProposta([1, 2, { x: null }]));
  assertNotEquals(hashDaProposta([1, 2]), hashDaProposta([2, 1])); // array É posicional
});
