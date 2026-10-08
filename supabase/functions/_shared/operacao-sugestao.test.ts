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

// ── camada 1: regras aprendidas (ADR 0041 D10; INV-188) ──────────────────────
import {
  historicoDoEstado,
  REGRAS_APRENDIDAS_SEED,
  type RegraAprendidaOperacao,
  regraAprendidaDeLinha,
  sugerirPorRegraAprendida,
  sugerirPorRegras,
  validarRegrasAprendidas,
} from "./operacao-sugestao.ts";

const ra = (o: Partial<RegraAprendidaOperacao> & { id: string }): RegraAprendidaOperacao => ({
  estado: { oc: 13 }, acao: "lancar_ocorrencia", codigo: 36, texto: "chegou na base", confianca: 0.8, casos: 30,
  base_regra: "historico:2026-07..09", ...o,
});

Deno.test("camada 1: o seed NASCE VAZIO e um regras.json válido passa na validação", () => {
  assertEquals(REGRAS_APRENDIDAS_SEED.length, 0);
  assertEquals(validarRegrasAprendidas([ra({ id: "a" }), ra({ id: "b", acao: "encaminhar_relacionamento", codigo: null, texto: "cliente autoriza" })]), []);
});

Deno.test("camada 1: validação recusa proibido, 41/56, a própria oc, encaminhar com código, texto > 70 e confiança fora de 0..1", () => {
  const erros = validarRegrasAprendidas([
    ra({ id: "p49", codigo: 49 }), ra({ id: "p56", codigo: 56 }), ra({ id: "pmesma", codigo: 13 }),
    ra({ id: "penc", acao: "encaminhar_relacionamento", codigo: 36 }), ra({ id: "plongo", texto: "x".repeat(71) }),
    ra({ id: "pconf", confianca: 1.2 }), ra({ id: "pconf" }),
  ]);
  for (const id of ["p49", "p56", "pmesma", "penc", "plongo", "pconf: conf", "pconf: id repetido"]) {
    assert(erros.some((e) => e.startsWith(id)), `faltou erro de ${id}: ${erros.join(" | ")}`);
  }
});

Deno.test("camada 1: mais específica vence (unidade, dias), abaixo do limiar não decide mas vira histórico", () => {
  const regras = [
    ra({ id: "geral", confianca: 0.9, casos: 100 }),
    ra({ id: "vga", estado: { oc: 13, unidade: "vga" }, codigo: 37, texto: "problema no veiculo", confianca: 0.7, casos: 8 }),
    ra({ id: "fraca", estado: { oc: 13, unidade: "POU" }, codigo: 37, confianca: 0.4, casos: 50 }),
    ra({ id: "poucos", estado: { oc: 15 }, casos: 3 }),
    ra({ id: "parada", estado: { oc: 21, dias_parado_min: 3 }, acao: "encaminhar_relacionamento", codigo: null, texto: "cliente ausente" }),
  ];
  const s = sugerirPorRegraAprendida({ item: item(), regras, codigosLancaveisAtivos: new Set([37]), agoraMs: AGORA });
  assertEquals([s?.regra_id, s?.fonte, s?.codigo, s?.lancavel, s?.confianca, s?.casos, s?.oc_base], ["vga", "regra_aprendida", 37, true, 0.7, 8, 13]);
  // POU: a específica é fraca (0.4) → cai na geral
  assertEquals(sugerirPorRegraAprendida({ item: item({ unidade: "POU" }), regras, codigosLancaveisAtivos: new Set(), agoraMs: AGORA })?.regra_id, "geral");
  // poucos casos não decide
  assertEquals(sugerirPorRegraAprendida({ item: item({ cod_ultima_ocorrencia: 15 }), regras, codigosLancaveisAtivos: new Set(), agoraMs: AGORA }), null);
  // dias parado: 26 h não bastam para 3 dias
  assertEquals(sugerirPorRegraAprendida({ item: item({ cod_ultima_ocorrencia: 21 }), regras, codigosLancaveisAtivos: new Set(), agoraMs: AGORA }), null);
  const enc = sugerirPorRegraAprendida({
    item: item({ cod_ultima_ocorrencia: 21, data_ultima_ocorrencia: "2026-10-01T00:00:00Z" }), regras, codigosLancaveisAtivos: new Set([36]), agoraMs: AGORA,
  });
  assertEquals([enc?.acao, enc?.codigo, enc?.lancavel], ["encaminhar_relacionamento", null, false]);
  // histórico do estado: só regras do MESMO estado (a de POU fica fora para item da VGA), mais específica primeiro
  assertEquals(historicoDoEstado(regras, item(), 3, AGORA).map((r) => r.id), ["vga", "geral"]);
  assertEquals(historicoDoEstado(regras, item({ unidade: "POU" }), 3, AGORA).map((r) => r.id), ["fraca", "geral"]);
});

Deno.test("camadas: regra fixa vence a aprendida; sem nenhuma → null (aí, e só aí, o agente)", () => {
  const fixas: RegraSugestaoOperacao[] = [{ id: "fixa", descricao: "d", quando: { ocs: [13] }, sugerir: { codigo: 14, texto: "saiu para entrega" } }];
  const aprendidas = [ra({ id: "apr" })];
  assertEquals(sugerirPorRegras({ item: item(), regrasFixas: fixas, regrasAprendidas: aprendidas, codigosLancaveisAtivos: new Set(), agoraMs: AGORA })?.fonte, "regra_fixa");
  assertEquals(sugerirPorRegras({ item: item(), regrasFixas: [], regrasAprendidas: aprendidas, codigosLancaveisAtivos: new Set(), agoraMs: AGORA })?.fonte, "regra_aprendida");
  assertEquals(sugerirPorRegras({ item: item(), regrasFixas: [], regrasAprendidas: [], codigosLancaveisAtivos: new Set(), agoraMs: AGORA }), null);
});

Deno.test("regra fixa pode sugerir encaminhar ao Relacionamento (sem código, nunca lançável)", () => {
  const regras: RegraSugestaoOperacao[] = [{ id: "enc", descricao: "d", quando: { ocs: [13] }, sugerir: { acao: "encaminhar_relacionamento", texto: "cliente precisa autorizar" } }];
  assertEquals(validarRegrasSugestao(regras), []);
  const s = sugerirLancamentoOperacao({ item: item(), regras, codigosLancaveisAtivos: new Set([36]), agoraMs: AGORA });
  assertEquals([s?.acao, s?.codigo, s?.lancavel, s?.versao_contrato], ["encaminhar_relacionamento", null, false, 2]);
});

Deno.test("linha de op_regras_sugestao (numeric como texto) vira regra", () => {
  const r = regraAprendidaDeLinha({
    id: "x", estado_oc: 13, estado_unidade: null, estado_dias_parado_min: null, acao: "lancar_ocorrencia", codigo: 36,
    texto: "chegou", confianca: "0.850", casos: 12, base_regra: "h", ativo: true,
  });
  assertEquals([r.confianca, r.estado.dias_parado_min, r.codigo], [0.85, null, 36]);
});

// ── treino real (07/10): instrução, pagador, aguardar, 01 ────────────────────
import {
  CODIGO_ENTREGA,
  especificidadeRegra,
  normalizarCnpj,
  normalizarInstrucaoPadrao,
  OCS_NUNCA_SUGERIR,
} from "./operacao-sugestao.ts";

Deno.test("normalização da instrução: maiúsculas, sem acento, espaços colapsados; CNPJ só dígitos", () => {
  assertEquals(normalizarInstrucaoPadrao("  comprovante   no\tMALOTE  "), "COMPROVANTE NO MALOTE");
  assertEquals(normalizarInstrucaoPadrao("Não localizado — endereço"), "NAO LOCALIZADO — ENDERECO");
  assertEquals(normalizarInstrucaoPadrao("   "), null);
  assertEquals([normalizarCnpj("12.345.678/0001-99"), normalizarCnpj("123"), normalizarCnpj("123.456.789-01")], ["12345678000199", null, "12345678901"]);
});

Deno.test("estado com instrução (igualdade normalizada) e pagador; hierarquia pagador > instrução > unidade > dias", () => {
  const regras = [
    ra({ id: "oc", estado: { oc: 41 }, codigo: 36, confianca: 0.95, casos: 500 }),
    ra({ id: "unid", estado: { oc: 41, unidade: "VGA" }, codigo: 37, casos: 50 }),
    ra({ id: "instr", estado: { oc: 41, instrucao_padrao: "COMPROVANTE NO MALOTE" }, acao: "aguardar", codigo: null, texto: "comprovante no malote", reavaliar_em_horas: 48, casos: 135 }),
    ra({ id: "pag", estado: { oc: 41, pagador_cnpj: "12345678000199" }, codigo: 14, texto: "saiu para entrega", casos: 66 }),
    ra({ id: "pag+instr", estado: { oc: 41, pagador_cnpj: "12345678000199", instrucao_padrao: "COMPROVANTE NO MALOTE" }, acao: "encaminhar_relacionamento", codigo: null, texto: "cliente pede original", casos: 9 }),
  ];
  assertEquals(regras.map(especificidadeRegra), [0, 2, 4, 8, 12]);
  const it = (o: Record<string, unknown>) => item({ cod_ultima_ocorrencia: 41, ...o } as never);
  const s = (o: Record<string, unknown>) => sugerirPorRegraAprendida({ item: it(o), regras, codigosLancaveisAtivos: new Set(), agoraMs: AGORA });
  // a instrução casa por igualdade DEPOIS de normalizar (acento, caixa, espaços)
  const a = s({ instrucao_ultima_ocorrencia: "  comprovante  no Malote " });
  assertEquals([a?.regra_id, a?.acao, a?.codigo, a?.lancavel, a?.reavaliar_em_horas, a?.reavaliar_em], ["instr", "aguardar", null, false, 48, "2026-10-09T12:00:00.000Z"]);
  // igualdade, não "contém"
  assertEquals(s({ instrucao_ultima_ocorrencia: "COMPROVANTE NO MALOTE DA BASE" })?.regra_id, "unid");
  // pagador (8) vence instrução (4); pagador + instrução (12) vence os dois
  assertEquals(s({ cnpj_pagador: "12.345.678/0001-99" })?.regra_id, "pag");
  assertEquals(s({ cnpj_pagador: "12345678000199", instrucao_ultima_ocorrencia: "Comprovante no malote" })?.regra_id, "pag+instr");
  // outro pagador não casa a regra do pagador
  assertEquals(s({ cnpj_pagador: "99999999000199", unidade: "POU" })?.regra_id, "oc");
});

Deno.test("validação: instrução não normalizada, CNPJ com máscara, 01, aguardar com código ou reavaliar inválido → recusa", () => {
  const erros = validarRegrasAprendidas([
    ra({ id: "i", estado: { oc: 41, instrucao_padrao: "comprovante no malote" } }),
    ra({ id: "c", estado: { oc: 41, pagador_cnpj: "12.345.678/0001-99" } }),
    ra({ id: "e", codigo: CODIGO_ENTREGA }),
    ra({ id: "a1", acao: "aguardar", codigo: 36 }),
    ra({ id: "a2", acao: "aguardar", codigo: null, reavaliar_em_horas: 721 }),
    ra({ id: "ok", acao: "aguardar", codigo: null, reavaliar_em_horas: 24, estado: { oc: 41, instrucao_padrao: "COMPROVANTE NO MALOTE", pagador_cnpj: "12345678000199" } }),
  ]);
  for (const id of ["i:", "c:", "e:", "a1:", "a2:"]) assert(erros.some((e) => e.startsWith(id)), `faltou ${id} ${erros.join(" | ")}`);
  assert(!erros.some((e) => e.startsWith("ok:")), erros.join(" | "));
  assert(OCS_NUNCA_SUGERIR.has(1) && OCS_NUNCA_SUGERIR.has(49) && OCS_NUNCA_SUGERIR.has(41));
});

Deno.test("regra fixa: 01 nunca sugere; aguardar sai com reavaliar padrão 24 h", () => {
  assert(validarRegrasSugestao([{ id: "e", descricao: "", quando: { ocs: [13] }, sugerir: { codigo: 1, texto: "entregue" } }]).some((e) => e.includes("01")));
  assertEquals(sugerirLancamentoOperacao({
    item: item(), regras: [{ id: "e", descricao: "", quando: { ocs: [13] }, sugerir: { codigo: 1, texto: "entregue" } }],
    codigosLancaveisAtivos: new Set([1]), agoraMs: AGORA,
  }), null);
  const s = sugerirLancamentoOperacao({
    item: item(), regras: [{ id: "ag", descricao: "d", quando: { ocs: [13] }, sugerir: { acao: "aguardar", texto: "malote a caminho" } }],
    codigosLancaveisAtivos: new Set(), agoraMs: AGORA,
  });
  assertEquals([s?.acao, s?.codigo, s?.lancavel, s?.reavaliar_em_horas], ["aguardar", null, false, 24]);
});

Deno.test("linha de op_regras_sugestao com instrução, pagador e reavaliar", () => {
  const r = regraAprendidaDeLinha({
    id: "x", estado_oc: 41, estado_unidade: null, estado_dias_parado_min: null, estado_instrucao_padrao: "COMPROVANTE NO MALOTE",
    estado_pagador_cnpj: "12345678000199", acao: "aguardar", codigo: null, texto: "aguardar malote", reavaliar_em_horas: 48,
    confianca: "0.900", casos: 135, base_regra: "treino:W5", ativo: true,
  });
  assertEquals([r.estado.instrucao_padrao, r.estado.pagador_cnpj, r.reavaliar_em_horas, r.acao], ["COMPROVANTE NO MALOTE", "12345678000199", 48, "aguardar"]);
});
