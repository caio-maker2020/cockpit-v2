// Guard — incidente WORKER_RESOURCE_LIMIT (08/10): a edge materializar-fila-operacao
// estourou o limite de CPU com 366 regras aprendidas e 4.883 itens. Causa medida:
// cada item revalidava e renormalizava TODAS as regras (≈1,8 milhão de pares;
// ~1.340 ms de CPU só no planejamento). Correção: regras compiladas uma vez por rodada.
// Este arquivo trava (1) que a sugestão é IDÊNTICA à do caminho antigo e (2) o custo.
// Rodar: DENO_NO_PACKAGE_JSON=1 deno test --no-check --allow-read supabase/functions/_shared/operacao-materializar-carga.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AGORA_CARGA, pendenciasSinteticas, regrasDaFixture } from "./operacao-carga-sintetica.ts";
import { planejarMaterializacao, resolverUnidade } from "./operacao-materializar.ts";
import {
  compilarRegrasAprendidas,
  especificidadeRegra,
  estadoCasa,
  type ItemParaSugestao,
  MIN_CASOS_REGRA_APRENDIDA,
  MIN_CONFIANCA_REGRA_APRENDIDA,
  problemaRegraAprendida,
  type RegraAprendidaOperacao,
  sugerirPorRegraAprendida,
} from "./operacao-sugestao.ts";

const REGRA_UNIDADE = [{ codigo_oc: null, campo_bastao: "unidade_atual" as const, prioridade: 1, ativo: true }];
const LANCAVEIS = new Set([36, 37, 38, 39]);

/** O caminho ANTIGO (até 08/10), copiado como referência: filtra, casa e ordena por item. */
function escolhaAntiga(regras: readonly RegraAprendidaOperacao[], item: ItemParaSugestao, agoraMs: number, minConf: number, minCasos: number) {
  return regras
    .filter((x) => x.ativo !== false && problemaRegraAprendida(x) === null)
    .filter((x) => x.confianca >= minConf && x.casos >= minCasos)
    .filter((x) => estadoCasa(x, item, agoraMs))
    .sort((a, b) =>
      especificidadeRegra(b) - especificidadeRegra(a) || b.confianca - a.confianca || b.casos - a.casos ||
      a.id.localeCompare(b.id)
    )[0] ?? null;
}

/** Regras reais + variações que a carga real ainda não tem (instrução exata, anteriores, inativa, unidade crua, empates). */
function regrasComVariacoes(): RegraAprendidaOperacao[] {
  const base = regrasDaFixture();
  const extra: RegraAprendidaOperacao[] = [];
  base.slice(0, 60).forEach((r, i) => {
    const e = { ...r.estado };
    if (i % 5 === 0 && e.instrucao_modelo && !e.instrucao_modelo.includes("#")) {
      extra.push({ ...r, id: `${r.id}-padrao`, estado: { ...e, instrucao_modelo: null, instrucao_padrao: e.instrucao_modelo } });
    }
    if (i % 5 === 1) extra.push({ ...r, id: `${r.id}-ant`, estado: { ...e, ocorrencias_anteriores_min: 2 } });
    if (i % 5 === 2) extra.push({ ...r, id: `${r.id}-inativa`, ativo: false, confianca: 1, casos: 999, estado: { ...e, pagador_cnpj: null, unidade: null } });
    if (i % 5 === 3) extra.push({ ...r, id: `${r.id}-empate`, texto: "EMPATE DE ORDEM" });
    if (i % 5 === 4) extra.push({ ...r, id: `${r.id}-unid-crua`, estado: { ...e, unidade: "vga " }, confianca: 1 });
  });
  return [...base, ...extra];
}

function itensDaCarga(n: number, seed: number) {
  return pendenciasSinteticas(n, regrasDaFixture(), seed).map((p, i): ItemParaSugestao => ({
    cod_ultima_ocorrencia: p.cod_ultima_ocorrencia, data_ultima_ocorrencia: p.data_ultima_ocorrencia,
    unidade: resolverUnidade(p, REGRA_UNIDADE), instrucao_ultima_ocorrencia: p.instrucao_ultima_ocorrencia,
    cnpj_pagador: p.cnpj_pagador, previsao_entrega: p.previsao_entrega, ocorrencias_anteriores: i % 4 === 0 ? null : i % 5,
  }));
}

Deno.test("equivalência: a regra escolhida e a sugestão inteira são as do caminho antigo (4.883 itens × 2 sementes × 3 limiares)", () => {
  const regras = regrasComVariacoes();
  let comparados = 0, comSugestao = 0;
  for (const seed of [1, 2026]) {
    const itens = itensDaCarga(4883, seed);
    for (const [minConf, minCasos] of [[MIN_CONFIANCA_REGRA_APRENDIDA, MIN_CASOS_REGRA_APRENDIDA], [0, 0], [0.9, 50]]) {
      const compiladas = compilarRegrasAprendidas(regras, { minConfianca: minConf, minCasos });
      for (const item of itens) {
        const antiga = escolhaAntiga(regras, item, AGORA_CARGA, minConf, minCasos);
        const args = { item, regras, codigosLancaveisAtivos: LANCAVEIS, agoraMs: AGORA_CARGA, minConfianca: minConf, minCasos };
        const nova = sugerirPorRegraAprendida({ ...args, compiladas });
        assertEquals(nova?.regra_id ?? null, antiga?.id ?? null);
        // sem compilado = compila na hora (amostra: compilar por item é o caminho caro)
        if (comparados % 97 === 0) assertEquals(nova, sugerirPorRegraAprendida(args));
        comparados++;
        if (nova) comSugestao++;
      }
    }
  }
  assert(comparados === 4883 * 6);
  assert(comSugestao > comparados / 3, `carga fraca: só ${comSugestao} de ${comparados} com sugestão`);
});

Deno.test("equivalência: plano do materializador com regras = plano com a sugestão escolhida pelo caminho antigo", () => {
  const regras = regrasDaFixture();
  const pend = pendenciasSinteticas(4883, regras, 7);
  const plano = planejarMaterializacao({
    pendencias: pend, codigosOperacao: new Set(pend.map((p) => p.cod_ultima_ocorrencia ?? -1)), ctrcsComCardAtivo: new Set(),
    itensAbertos: [], encerradosPorCtrc24h: new Map(), regrasUnidade: REGRA_UNIDADE, codigosLancaveisAtivos: LANCAVEIS,
    regrasAprendidas: regras, agoraMs: AGORA_CARGA,
  });
  const porCtrc = new Map(pend.map((p) => [p.ctrc, p]));
  assert(plano.upserts.length > 4000);
  for (const u of plano.upserts) {
    const p = porCtrc.get(u.ctrc)!;
    const antiga = escolhaAntiga(regras, {
      cod_ultima_ocorrencia: p.cod_ultima_ocorrencia, data_ultima_ocorrencia: p.data_ultima_ocorrencia, unidade: u.unidade,
      instrucao_ultima_ocorrencia: p.instrucao_ultima_ocorrencia, cnpj_pagador: p.cnpj_pagador, previsao_entrega: p.previsao_entrega,
    }, AGORA_CARGA, MIN_CONFIANCA_REGRA_APRENDIDA, MIN_CASOS_REGRA_APRENDIDA);
    assertEquals(u.sugestao?.regra_id ?? null, antiga?.id ?? null);
  }
});

Deno.test("custo: 4.883 itens × 374 regras planejam bem abaixo de 2 s de CPU do Edge (antes: ~1.340 ms)", () => {
  const regras = regrasDaFixture();
  const pend = pendenciasSinteticas(4883, regras);
  const args = {
    pendencias: pend, codigosOperacao: new Set(pend.map((p) => p.cod_ultima_ocorrencia ?? -1)), ctrcsComCardAtivo: new Set<string>(),
    itensAbertos: [], encerradosPorCtrc24h: new Map<string, number>(), regrasUnidade: REGRA_UNIDADE,
    codigosLancaveisAtivos: LANCAVEIS, regrasAprendidas: regras, agoraMs: AGORA_CARGA,
  };
  planejarMaterializacao(args); // aquece o JIT
  const t0 = performance.now();
  const plano = planejarMaterializacao(args);
  const ms = performance.now() - t0;
  console.log(`planejar: ${plano.upserts.length} itens, ${plano.upserts.filter((u) => u.sugestao).length} com sugestão, ${ms.toFixed(0)} ms`);
  assert(ms < 300, `planejamento levou ${ms.toFixed(0)} ms (folga perdida)`);
});
