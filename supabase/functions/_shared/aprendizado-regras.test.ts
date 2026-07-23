// deno test supabase/functions/_shared/aprendizado-regras.test.ts
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  agruparPorSugestao,
  chavePergunta,
  compararSemanas,
  montarPergunta,
  selecionarPerguntas,
  type ParFeedback,
} from "./aprendizado-regras.ts";

const NOMES: Record<number, string> = {
  21: "Reentrega solicitada pelo cliente",
  54: "Aguardando retorno cliente pagador",
  56: "Falta de informação operacional ou indevida",
};

function par(p: Partial<ParFeedback>): ParFeedback {
  return {
    agent_name: "interpretador-resposta-cliente",
    veredito: "seguida",
    origem: "implicit",
    oc_card: 54,
    oc_sugerida: 54,
    oc_executada: null,
    reason_text: null,
    operador_card: "DUILIO",
    nf: "100",
    decidido_em: "2026-07-17T12:00:00Z",
    ...p,
  };
}

Deno.test("agrupar: conta seguidas/corrigidas e abstenção fora do denominador", () => {
  const pares = [
    par({}),
    par({ veredito: "corrigida", oc_executada: 21, nf: "101" }),
    par({ veredito: "corrigida", oc_executada: 21, nf: "102" }),
    par({ veredito: "abstencao" }),
  ];
  const [g] = agruparPorSugestao(pares);
  assertEquals(g.pares, 4);
  assertEquals(g.seguidas, 1);
  assertEquals(g.corrigidas, 2);
  assertEquals(g.abstencoes, 1);
  // taxa = 2/(1+2), abstenção NÃO conta (spec §9)
  assertEquals(Math.round(g.taxaCorrecao * 100), 67);
  assertEquals(g.trocas[0].ocExecutada, 21);
  assertEquals(g.trocas[0].casos, 2);
});

Deno.test("selecionar: respeita evidência mínima, dedup e diversidade por agente", () => {
  const pares: ParFeedback[] = [];
  // grupo A: interp sug54 — 10 corrigidas (elegível)
  for (let i = 0; i < 10; i++) pares.push(par({ veredito: "corrigida", oc_executada: 21, nf: `a${i}` }));
  pares.push(par({}));
  // grupo B: interp sug56 — 8 corrigidas (mesmo agente — diversidade deixa por último)
  for (let i = 0; i < 8; i++) pares.push(par({ oc_sugerida: 56, veredito: "corrigida", oc_executada: 54, nf: `b${i}` }));
  // grupo C: padrao sug56 — 6 corrigidas (agente diferente — entra antes do B)
  for (let i = 0; i < 6; i++) {
    pares.push(par({ agent_name: "agente-sugere-ocs-padrao", oc_sugerida: 56, veredito: "corrigida", oc_executada: 54, nf: `c${i}` }));
  }
  // grupo D: só 2 corrigidas — abaixo da evidência mínima
  for (let i = 0; i < 2; i++) {
    pares.push(par({ agent_name: "agente-oc13-autonomo", oc_sugerida: null, veredito: "corrigida", oc_executada: 21 }));
  }

  const grupos = agruparPorSugestao(pares);
  const escolhidos = selecionarPerguntas(grupos, { maxPerguntas: 3 });
  const chaves = escolhidos.map(chavePergunta);
  // diversidade: os dois primeiros são de agentes distintos
  assertEquals(chaves[0], "interpretador-resposta-cliente:sug54");
  assertEquals(chaves[1], "agente-sugere-ocs-padrao:sug56");
  assertEquals(chaves[2], "interpretador-resposta-cliente:sug56");
  // grupo D ficou fora (evidência < 5)
  assert(!chaves.some((c) => c.startsWith("agente-oc13")));

  // dedup: chave já perguntada não volta
  const escolhidos2 = selecionarPerguntas(grupos, {
    maxPerguntas: 3,
    chavesJaPerguntadas: new Set(["interpretador-resposta-cliente:sug54"]),
  });
  assert(!escolhidos2.map(chavePergunta).includes("interpretador-resposta-cliente:sug54"));
});

Deno.test("montarPergunta: troca dominante vira título direto com contagem + template de domínio", () => {
  // padrão sugeriu 56, time lançou 54 (o caso clássico da régua de evidência)
  const pares = Array.from({ length: 12 }, (_, i) =>
    par({
      agent_name: "agente-sugere-ocs-padrao",
      oc_sugerida: 56,
      veredito: "corrigida",
      oc_executada: 54,
      nf: `e${i}`,
    }));
  const [g] = agruparPorSugestao(pares);
  const p = montarPergunta(g, NOMES);
  // título direto: "sugeriu X e o time lançou Y — Nx"
  assert(p.titulo.includes('sugeriu "56'));
  assert(p.titulo.includes('lançou "54'));
  assert(p.titulo.includes("12x"));
  // pergunta de domínio (régua de evidência), não a genérica
  assert(p.pergunta.includes("régua de evidência"));
  assert(p.opcoes[0].includes("agressiva"));
  // iteração 3: cada opção tem pergunta-seguimento estruturada
  assertEquals(p.opcoesV2.length, 4);
  const primeira = p.opcoesV2[0];
  assert(primeira.followup !== undefined);
  assert(primeira.followup!.exige_imagem === true); // caso de evidência → print obrigatório
  assert(primeira.followup!.opcoes.length >= 3); // opções marcáveis, não texto livre
});

Deno.test("followup do 'time se antecipou' (54→21) pergunta o que faltava, estruturado", () => {
  const pares = Array.from({ length: 8 }, (_, i) =>
    par({ veredito: "corrigida", oc_executada: 21, nf: `s${i}` }));
  const [g] = agruparPorSugestao(pares);
  const p = montarPergunta(g, NOMES);
  const antecipou = p.opcoesV2.find((o) => o.id === "time_se_antecipou");
  assert(antecipou?.followup);
  assert(antecipou!.followup!.pergunta.includes("FALTAVA"));
  assert(antecipou!.followup!.multi === true);
  assert(antecipou!.followup!.opcoes.some((o) => o.id === "faltou_pagador"));
});

Deno.test("montarPergunta: linguagem simples com nome da oc e sem inventar motivo", () => {
  const pares = [
    par({}),
    ...Array.from({ length: 9 }, (_, i) =>
      par({ veredito: "corrigida", oc_executada: 21, nf: `n${i}` })),
  ];
  const [g] = agruparPorSugestao(pares);
  const p = montarPergunta(g, NOMES);
  assert(p.titulo.includes("54 — Aguardando retorno cliente pagador"));
  assert(p.oQueAconteceu.includes("seguiu 1"));
  assert(p.oQueAconteceu.includes("corrigiu 9"));
  assert(p.pergunta.includes("21 — Reentrega solicitada pelo cliente"));
  assertEquals(p.opcoes.length, 4);
  assertEquals(p.chavePadrao, "interpretador-resposta-cliente:sug54");
  assert(p.casosAncora.length > 0 && p.casosAncora.length <= 5);
  // nunca inventa motivo: nenhum motivo registrado → nada de "porque" no texto
  assertEquals(g.motivosRegistrados.length, 0);
});

Deno.test("medirImpactoResposta: melhora = taxa de correção caindo; volume baixo = cedo demais", async () => {
  const { medirImpactoResposta, parseChavePadrao } = await import("./aprendizado-regras.ts");
  // antes: 10 corrigidas de 20 (50%) → depois: 3 de 15 (20%) = MELHOROU
  const m = medirImpactoResposta(
    { seguidas: 10, corrigidas: 10 },
    { seguidas: 12, corrigidas: 3 },
  );
  assertEquals(m.status, "melhorou");
  assertEquals(m.taxaAntesPct, 50);
  assertEquals(m.taxaDepoisPct, 20);
  // volume insuficiente depois → cedo demais, sem conclusão
  const cedo = medirImpactoResposta(
    { seguidas: 10, corrigidas: 10 },
    { seguidas: 2, corrigidas: 1 },
  );
  assertEquals(cedo.status, "cedo_demais");
  assertEquals(cedo.deltaPts, null);
  // variação pequena → estável
  const est = medirImpactoResposta(
    { seguidas: 10, corrigidas: 10 },
    { seguidas: 9, corrigidas: 9 },
  );
  assertEquals(est.status, "estavel");
  // parse da chave
  assertEquals(parseChavePadrao("agente-sugere-ocs-padrao:sug56"), {
    agentName: "agente-sugere-ocs-padrao",
    ocSugerida: 56,
  });
  assertEquals(parseChavePadrao("agente-oc13-autonomo:sugsem"), {
    agentName: "agente-oc13-autonomo",
    ocSugerida: null,
  });
  assertEquals(parseChavePadrao("lixo"), null);
});

Deno.test("compararSemanas: delta em pontos e null quando sem histórico", () => {
  const atual = [
    { agentName: "agente-sugere-ocs-padrao", pares: 100, seguidas: 75, corrigidas: 25, abstencoes: 0 },
    { agentName: "novo-agente", pares: 10, seguidas: 9, corrigidas: 1, abstencoes: 0 },
  ];
  const anterior = [
    { agentName: "agente-sugere-ocs-padrao", pares: 90, seguidas: 63, corrigidas: 27, abstencoes: 0 },
  ];
  const cmp = compararSemanas(atual, anterior);
  assertEquals(cmp[0].pctAcertoAtual, 75);
  assertEquals(cmp[0].pctAcertoAnterior, 70);
  assertEquals(cmp[0].deltaPontos, 5);
  assertEquals(cmp[1].deltaPontos, null);
});
