// Guard — sugestão da Operação por regras puras, em sombra (ADR 0041 D6; INV-185).
// Rodar: deno test --no-check supabase/functions/_shared/operacao-sugestao.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  REGRAS_SUGESTAO_OPERACAO,
  type RegraSugestaoOperacao,
  sugerirLancamentoOperacao,
  validarRegrasSugestao,
} from "./operacao-sugestao.ts";

const AGORA = Date.parse("2026-10-07T12:00:00Z");
const item = (o: Partial<{ cod_ultima_ocorrencia: number | null; data_ultima_ocorrencia: string | null; unidade: string | null }> = {}) =>
  ({ cod_ultima_ocorrencia: 13, data_ultima_ocorrencia: "2026-10-06T10:00:00Z", unidade: "VGA", ...o });

Deno.test("a tabela de regras NASCE VAZIA e é válida (sem LLM, conservadora)", () => {
  assertEquals(REGRAS_SUGESTAO_OPERACAO.length, 0);
  assertEquals(validarRegrasSugestao(REGRAS_SUGESTAO_OPERACAO), []);
  assertEquals(sugerirLancamentoOperacao({ item: item(), codigosLancaveisAtivos: new Set([36]), agoraMs: AGORA }), null);
});

Deno.test("validação recusa regra que sugere código proibido, 41/56 (texto é da pessoa) ou sem oc", () => {
  const ruins: RegraSugestaoOperacao[] = [
    { id: "a", descricao: "", quando: { ocs: [13] }, sugerir: { codigo: 49, texto: "x x x" } },
    { id: "b", descricao: "", quando: { ocs: [13] }, sugerir: { codigo: 41, texto: "x x x" } },
    { id: "c", descricao: "", quando: { ocs: [] }, sugerir: { codigo: 36, texto: "x x x" } },
    { id: "c", descricao: "", quando: { ocs: [13] }, sugerir: { codigo: 33, texto: "x x x" } },
  ];
  const erros = validarRegrasSugestao(ruins);
  assert(erros.some((e) => e.includes("49")));
  assert(erros.some((e) => e.includes("41")));
  assert(erros.some((e) => e.includes("sem oc")));
  assert(erros.some((e) => e.includes("repetido")));
  assert(erros.some((e) => e.includes("33")));
});

Deno.test("primeira regra que casa decide; horas paradas e unidade filtram; regra inválida nunca sugere", () => {
  const regras: RegraSugestaoOperacao[] = [
    { id: "proibida", descricao: "", quando: { ocs: [13] }, sugerir: { codigo: 54, texto: "nunca" } },
    { id: "pou", descricao: "", quando: { ocs: [13], unidades: ["pou"] }, sugerir: { codigo: 37, texto: "veiculo" } },
    { id: "parada", descricao: "parada 24h", quando: { ocs: [13], horasParadoMin: 24 }, sugerir: { codigo: 36, texto: "chegou" } },
  ];
  const s = sugerirLancamentoOperacao({ item: item(), regras, codigosLancaveisAtivos: new Set([36]), agoraMs: AGORA });
  assertEquals([s?.regra_id, s?.codigo, s?.lancavel], ["parada", 36, true]);
  assertEquals(sugerirLancamentoOperacao({ item: item({ data_ultima_ocorrencia: "2026-10-07T08:00:00Z" }), regras, codigosLancaveisAtivos: new Set(), agoraMs: AGORA }), null);
  assertEquals(sugerirLancamentoOperacao({ item: item({ unidade: "POU" }), regras, codigosLancaveisAtivos: new Set(), agoraMs: AGORA })?.regra_id, "pou");
  assertEquals(sugerirLancamentoOperacao({ item: item({ cod_ultima_ocorrencia: null }), regras, codigosLancaveisAtivos: new Set(), agoraMs: AGORA }), null);
});

Deno.test("sugestão de código fora da lista ativa fica só em sombra (lancavel=false)", () => {
  const regras: RegraSugestaoOperacao[] = [{ id: "r", descricao: "", quando: { ocs: [13] }, sugerir: { codigo: 36, texto: "chegou" } }];
  assertEquals(sugerirLancamentoOperacao({ item: item(), regras, codigosLancaveisAtivos: new Set(), agoraMs: AGORA })?.lancavel, false);
});
