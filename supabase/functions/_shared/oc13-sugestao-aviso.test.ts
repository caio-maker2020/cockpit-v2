// Guard INV-174 (Caio 2026-10-08): a sugestão do agente-oc13 precisa chegar ao
// carimbo `sugestao_vigente` (mig 378) nos 3 ramos, e o agente NÃO pode voltar a
// reanalisar card concluído (precedência do `.or()`, bug desde 21/05).
import { assert, assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  destaqueSugestaoOc13,
  ehDecisaoSugestaoOc13,
  filtroSelecaoCardsOc13,
} from "./oc13-sugestao-aviso.ts";

Deno.test("carimbo: os 3 ramos trazem número E acao_key (set/26: 22/22 da 21 saíam vazias)", () => {
  for (const d of ["sugerir_54_email", "sugerir_56", "sugerir_21_cancel"] as const) {
    const x = destaqueSugestaoOc13(d);
    assert(typeof x.proposta_destacada === "number", d);
    assert(x.proposta_destacada_acao.length > 0, d);
    assertEquals(Number(x.proposta_destacada_acao.split(":")[1]), x.proposta_destacada, d);
  }
});

Deno.test("54+email recomenda a variante QUE ENVIA e-mail (INV-027, NF 1093446)", () => {
  const x = destaqueSugestaoOc13("sugerir_54_email");
  assertEquals(x.proposta_destacada, 54);
  assertEquals(x.proposta_destacada_acao, "lancar_oc_e_enviar_email:54");
  assertEquals(x.analise_acao_key, "lancar_oc_e_enviar_email:54");
  assertEquals(x.tipoAviso, "ia_sugestao_oc13");
});

Deno.test("56 casa por acao_key própria", () => {
  const x = destaqueSugestaoOc13("sugerir_56");
  assertEquals(x.proposta_destacada, 56);
  assertEquals(x.proposta_destacada_acao, "lancar_ocorrencia:56");
  assertEquals(x.analise_acao_key, "lancar_ocorrencia:56");
  assertEquals(x.tipoAviso, "ia_sugestao_oc13_revisar");
});

Deno.test("21+cancel: carimbo recebe 21 + lancar_ocorrencia:21; popup F4 (analise) continua sem acao_key", () => {
  const x = destaqueSugestaoOc13("sugerir_21_cancel");
  assertEquals(x.proposta_destacada, 21);
  assertEquals(x.proposta_destacada_acao, "lancar_ocorrencia:21");
  assertStrictEquals(x.analise_acao_key, null);
  assertEquals(x.sugestaoLabel, "oc=21 + cancelar reentrega");
  assertEquals(x.tipoAviso, "ia_sugestao_oc13_21_cancel");
});

Deno.test("type guard: só os 3 ramos de sugestão; autônoma e erro ficam fora", () => {
  assert(ehDecisaoSugestaoOc13("sugerir_54_email"));
  assert(ehDecisaoSugestaoOc13("sugerir_56"));
  assert(ehDecisaoSugestaoOc13("sugerir_21_cancel"));
  assert(!ehDecisaoSugestaoOc13("autonoma"));
  assert(!ehDecisaoSugestaoOc13("operador_antecipou"));
  assert(!ehDecisaoSugestaoOc13(null));
});

Deno.test("seleção: concluída NÃO volta; 'analisando' só com o relógio travado (and agrupado)", () => {
  const f = filtroSelecaoCardsOc13("2026-10-08T12:00:00.000Z");
  assertEquals(
    f,
    "analise_oc13_status.is.null,analise_oc13_status.in.(pendente,falhou)," +
      "and(analise_oc13_status.eq.analisando,analise_oc13_atualizado_em.lt.2026-10-08T12:00:00.000Z)",
  );
  // o bug: um ramo `and(...)` só com o relógio pega QUALQUER status, inclusive concluida
  assert(!/,and\(analise_oc13_atualizado_em/.test(f), "ramo de relógio solto = reanálise de card concluído");
  assert(!/(^|,)analise_oc13_status\.eq\.analisando(,|$)/.test(f), "'analisando' solto (fora do and) = retry imediato");
  assert(!f.includes("concluida"));
});
