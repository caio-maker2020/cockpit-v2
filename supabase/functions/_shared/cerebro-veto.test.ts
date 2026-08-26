// Guard INV-103 do loop de aprendizado (Caio 26/08): veto SEM divergência
// (operador cancelou e fez a MESMA ação — caso real NF 120149/ISABELY) NUNCA
// vira padrão/proposta de agente; agrupamento e dossiê são puros e exatos
// (total = soma das partes). Rodar: deno test _shared/cerebro-veto.test.ts

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  agruparPadroes,
  CATEGORIAS_VETO,
  divergenciaDoVeto,
  montarDossieMd,
  montarPromptProposta,
  resumirEdicoes,
  SYSTEM_CLASSIFICACAO,
  type VetoClassificado,
} from "./cerebro-veto.ts";

const veto = (p: Partial<VetoClassificado>): VetoClassificado => ({
  cardId: "c1", nf: "111", agente: "interpretador-resposta-cliente",
  acaoKey: "lancar_ocorrencia:55", ciclo: 1, operador: "ISABELY",
  categoria: "leu_autorizacao_inexistente", leuErrado: "não autorizou",
  infoNoCockpit: "sim_interpretou_errado", excecaoCliente: false,
  correcaoAcaoKey: "lancar_oc_e_enviar_email:54", divergencia: "divergente",
  ...p,
});

Deno.test("divergenciaDoVeto: mesma ação = sem_divergencia; nada = pendente; outra = divergente", () => {
  assertEquals(divergenciaDoVeto("lancar_ocorrencia:55", "lancar_ocorrencia:55"), "sem_divergencia");
  assertEquals(divergenciaDoVeto("lancar_ocorrencia:55", null), "pendente");
  assertEquals(divergenciaDoVeto("lancar_ocorrencia:55", "lancar_oc_e_enviar_email:54"), "divergente");
});

Deno.test("INV-103: veto sem divergência NUNCA entra em padrão de agente", () => {
  const padroes = agruparPadroes([
    veto({ cardId: "a", nf: "1" }),
    veto({ cardId: "b", nf: "2" }),
    veto({ cardId: "c", nf: "3", divergencia: "sem_divergencia", correcaoAcaoKey: "lancar_ocorrencia:55" }),
  ]);
  assertEquals(padroes.length, 1);
  assertEquals(padroes[0]!.n, 2); // o sem_divergencia ficou FORA
  assertEquals(padroes[0]!.nfs, ["1", "2"]);
});

Deno.test("agrupamento: chave agente×ação×categoria; correções contadas; pendentes à parte", () => {
  const padroes = agruparPadroes([
    veto({ cardId: "a", nf: "1" }),
    veto({ cardId: "b", nf: "2", divergencia: "pendente", correcaoAcaoKey: null }),
    veto({ cardId: "c", nf: "3", categoria: "timing_prematuro" }),
  ]);
  assertEquals(padroes.length, 2);
  const principal = padroes.find((p) => p.categoria === "leu_autorizacao_inexistente")!;
  assertEquals(principal.n, 2);
  assertEquals(principal.pendentes, 1);
  assertEquals(principal.correcoes["lancar_oc_e_enviar_email:54"], 1);
});

Deno.test("resumirEdicoes agrega por ação×campo com 1 exemplo", () => {
  const r = resumirEdicoes([
    { acaoKey: "lancar_oc_e_enviar_email:54", campo: "email", antes: "corpo A", depois: "corpo B" },
    { acaoKey: "lancar_oc_e_enviar_email:54", campo: "email", antes: "corpo C", depois: "corpo D" },
    { acaoKey: "lancar_ocorrencia:56", campo: "texto_descricao", antes: null, depois: "x" },
  ]);
  assertEquals(r[0]!.n, 2);
  assertEquals(r[0]!.exemplo!.antes, "corpo A");
  assertEquals(r.length, 2);
});

Deno.test("dossiê: seções obrigatórias + trava 'nada vira regra sozinho'", () => {
  const md = montarDossieMd({
    periodo: "19/08–26/08",
    totalVetos: 3,
    pendentes: 1,
    padroes: [{ ...agruparPadroes([veto({}), veto({ cardId: "b", nf: "2" })])[0]!, proposta: "REGRA: X." }],
    semDivergencia: [{ operador: "ISABELY", nf: "120149", acaoKey: "lancar_ocorrencia:55" }],
    edicoes: [],
  });
  assertStringIncludes(md, "Padrões (candidatos a regra");
  assertStringIncludes(md, "treinamento de OPERADOR");
  assertStringIncludes(md, "120149");
  assertStringIncludes(md, "REGRA: X.");
  assertStringIncludes(md, "ordem do Caio");
});

Deno.test("prompts: taxonomia completa no system; proposta carrega NFs e correções", () => {
  for (const c of CATEGORIAS_VETO) assertStringIncludes(SYSTEM_CLASSIFICACAO, c);
  const p = montarPromptProposta(agruparPadroes([veto({}), veto({ cardId: "b", nf: "2" })])[0]!);
  assertStringIncludes(p, "NFs: 111, 2");
  assertStringIncludes(p, "lancar_oc_e_enviar_email:54 (2x)");
});
