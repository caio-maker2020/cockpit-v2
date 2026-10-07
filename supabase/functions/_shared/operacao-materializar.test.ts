// Guard — materializador da fila da Operação (ADR 0041 D4; INV-182, INV-040).
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/operacao-materializar.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { LIMITE_TERMINAIS_24H } from "./guard-anti-loop-criacao.ts";
import {
  ehDaOperacao,
  type ItemAberto,
  LIMITE_ENCERRADOS_24H_OPERACAO,
  type PendenciaOperacao,
  planejarMaterializacao,
  type RegraUnidade,
  type RepoMaterializacao,
  resolverUnidade,
  rodarMaterializacao,
} from "./operacao-materializar.ts";
import type { RegraSugestaoOperacao } from "./operacao-sugestao.ts";

const AGORA = Date.parse("2026-10-07T12:00:00Z");
const OPERACAO = new Set([1, 2, 13, 14, 15, 21, 32, 34, 36, 37, 41, 56]);

function pend(o: Partial<PendenciaOperacao> & { ctrc: string }): PendenciaOperacao {
  return {
    id: `b-${o.ctrc}`, nf: "000001234", filial: "VGA", cod_ultima_ocorrencia: 13, instrucao_ultima_ocorrencia: null,
    data_ultima_ocorrencia: "2026-10-06T10:00:00Z", responsavel_atual: "operacao", pagador: "P", cnpj_pagador: "1",
    destinatario: "D", cidade_destino: "Varginha", uf_destino: "MG", base_destino: "VGA", unidade_origem: "BHZ",
    unidade_destino: "VGA", unidade_atual: "vga ", previsao_entrega: null, atraso_original: 2, qtd_volumes: 3, ...o,
  };
}
const REGRA_ATUAL: RegraUnidade = { codigo_oc: null, campo_bastao: "unidade_atual", prioridade: 100, ativo: true };

function plano(p: Partial<Parameters<typeof planejarMaterializacao>[0]>) {
  return planejarMaterializacao({
    pendencias: [], codigosOperacao: OPERACAO, ctrcsComCardAtivo: new Set(), itensAbertos: [],
    encerradosPorCtrc24h: new Map(), regrasUnidade: [REGRA_ATUAL], codigosLancaveisAtivos: new Set(), agoraMs: AGORA, ...p,
  });
}

Deno.test("responsabilidade: responsavel_atual manda; vazio cai no dicionário (mesma hierarquia do state_pelo_bastao)", () => {
  assert(ehDaOperacao({ responsavel_atual: "operacao", cod_ultima_ocorrencia: 54 }, OPERACAO));
  assert(ehDaOperacao({ responsavel_atual: " Operação ", cod_ultima_ocorrencia: null }, OPERACAO));
  assert(!ehDaOperacao({ responsavel_atual: "relacionamento", cod_ultima_ocorrencia: 13 }, OPERACAO));
  assert(!ehDaOperacao({ responsavel_atual: "cliente", cod_ultima_ocorrencia: 13 }, OPERACAO));
  assert(ehDaOperacao({ responsavel_atual: null, cod_ultima_ocorrencia: 13 }, OPERACAO));
  assert(!ehDaOperacao({ responsavel_atual: "", cod_ultima_ocorrencia: 49 }, OPERACAO));
});

Deno.test("NUNCA entra: finalizadoras 1/30/32, documentais 2/34 e CTRC com card ATIVO do Relacionamento", () => {
  const p = plano({
    pendencias: [
      pend({ ctrc: "F1-1", cod_ultima_ocorrencia: 1 }), pend({ ctrc: "F30-1", cod_ultima_ocorrencia: 30 }),
      pend({ ctrc: "F32-1", cod_ultima_ocorrencia: 32 }), pend({ ctrc: "D2-1", cod_ultima_ocorrencia: 2 }),
      pend({ ctrc: "D34-1", cod_ultima_ocorrencia: 34 }), pend({ ctrc: "card1-1" }), pend({ ctrc: "OK1-1" }),
    ],
    ctrcsComCardAtivo: new Set(["CARD1-1"]),
  });
  assertEquals(p.upserts.map((u) => u.ctrc), ["OK1-1"]);
  assertEquals(p.ignorados.nota_finalizada, 3);
  assertEquals(p.ignorados.oc_documental, 2);
  assertEquals(p.ignorados.card_relacionamento_ativo, 1);
});

Deno.test("item aberto cujo CTRC ganhou card ativo / finalizou → encerra com o motivo", () => {
  const abertos: ItemAberto[] = [
    { id: "i1", ctrc: "A1-1", snapshot_hash: null, lancamento_ativo: null },
    { id: "i2", ctrc: "A2-2", snapshot_hash: null, lancamento_ativo: null },
  ];
  const p = plano({
    pendencias: [pend({ ctrc: "A1-1" }), pend({ ctrc: "A2-2", cod_ultima_ocorrencia: 1 })],
    itensAbertos: abertos, ctrcsComCardAtivo: new Set(["A1-1"]),
  });
  assertEquals(p.encerrar, [
    { op_item_id: "i1", ctrc: "A1-1", motivo: "card_relacionamento_ativo" },
    { op_item_id: "i2", ctrc: "A2-2", motivo: "nota_finalizada" },
  ]);
  assertEquals(p.upserts, []);
});

Deno.test("CTRC, NF e unidade normalizados; unidade pela regra (específica da oc vence a genérica)", () => {
  const regras: RegraUnidade[] = [REGRA_ATUAL, { codigo_oc: 36, campo_bastao: "base_destino", prioridade: 200, ativo: true }];
  assertEquals(resolverUnidade(pend({ ctrc: "x", cod_ultima_ocorrencia: 13 }), regras), "VGA");
  assertEquals(resolverUnidade(pend({ ctrc: "x", cod_ultima_ocorrencia: 36, base_destino: "pou" }), regras), "POU");
  assertEquals(resolverUnidade(pend({ ctrc: "x", unidade_atual: null }), [REGRA_ATUAL]), null);
  assertEquals(resolverUnidade(pend({ ctrc: "x" }), []), null, "tabela vazia = sem unidade (só supervisor/gestor veem)");
  assertEquals(resolverUnidade(pend({ ctrc: "x" }), [{ ...REGRA_ATUAL, ativo: false }]), null);
  const p = plano({ pendencias: [pend({ ctrc: " amb1-1 ", nf: "000045" })] });
  assertEquals([p.upserts[0]!.ctrc, p.upserts[0]!.nf, p.upserts[0]!.unidade, p.upserts[0]!.novo], ["AMB1-1", "45", "VGA", true]);
});

Deno.test("INV-040: com LIMITE_TERMINAIS_24H encerrados do CTRC em 24 h o item NÃO renasce (mesmo limite do sync)", () => {
  assertEquals(LIMITE_ENCERRADOS_24H_OPERACAO, LIMITE_TERMINAIS_24H);
  const p = plano({
    pendencias: [pend({ ctrc: "LOOP-1" }), pend({ ctrc: "QUASE-1" })],
    encerradosPorCtrc24h: new Map([["LOOP-1", LIMITE_TERMINAIS_24H], ["QUASE-1", LIMITE_TERMINAIS_24H - 1]]),
  });
  assertEquals(p.bloqueados_loop, ["LOOP-1"]);
  assertEquals(p.upserts.map((u) => u.ctrc), ["QUASE-1"]);
  // item já aberto não é "criação": atualiza mesmo com histórico de encerrados
  const p2 = plano({
    pendencias: [pend({ ctrc: "LOOP-1", cod_ultima_ocorrencia: 14 })],
    itensAbertos: [{ id: "i", ctrc: "LOOP-1", snapshot_hash: "velho", lancamento_ativo: null }],
    encerradosPorCtrc24h: new Map([["LOOP-1", 9]]),
  });
  assertEquals(p2.upserts.length, 1);
  assertEquals(p2.bloqueados_loop, []);
});

Deno.test("sem mudança não regrava; mudança de oc regrava", () => {
  const a = plano({ pendencias: [pend({ ctrc: "S1-1" })] });
  const hash = a.upserts[0]!.snapshot_hash;
  const abertos: ItemAberto[] = [{ id: "i", ctrc: "S1-1", snapshot_hash: hash, lancamento_ativo: null }];
  assertEquals(plano({ pendencias: [pend({ ctrc: "S1-1" })], itensAbertos: abertos }).upserts, []);
  const b = plano({ pendencias: [pend({ ctrc: "S1-1", cod_ultima_ocorrencia: 14 })], itensAbertos: abertos });
  assertEquals(b.upserts.length, 1);
  assertEquals(b.upserts[0]!.novo, false);
});

Deno.test("sumiu da lista → encerra; MAS Bastão vazio, leitura incompleta ou sumiço em massa NÃO encerram", () => {
  const abertos = Array.from({ length: 30 }, (_, i): ItemAberto => ({ id: `i${i}`, ctrc: `M${i}-1`, snapshot_hash: null, lancamento_ativo: null }));
  // 1 some de 30: encerra
  const vivos = abertos.slice(1).map((i) => pend({ ctrc: i.ctrc }));
  assertEquals(plano({ pendencias: vivos, itensAbertos: abertos }).encerrar, [{ op_item_id: "i0", ctrc: "M0-1", motivo: "saiu_da_operacao" }]);
  // Bastão vazio
  const vazio = plano({ pendencias: [], itensAbertos: abertos });
  assertEquals(vazio.encerrar, []);
  assert(vazio.fechamento_retido);
  // 20 de 30 somem numa leitura
  const massa = plano({ pendencias: abertos.slice(20).map((i) => pend({ ctrc: i.ctrc })), itensAbertos: abertos });
  assertEquals(massa.encerrar, []);
  assert(massa.fechamento_retido);
  // leitura incompleta
  const inc = plano({ pendencias: vivos, itensAbertos: abertos, leituraCompleta: false });
  assertEquals(inc.encerrar, []);
  assert(inc.fechamento_retido);
});

Deno.test("confirmação pela leitura seguinte: Bastão mostra a oc lançada → confirmar; outra oc → não confirma", () => {
  const abertos: ItemAberto[] = [
    { id: "i1", ctrc: "C1-1", snapshot_hash: null, lancamento_ativo: { id: "L1", codigo_oc: 36, status: "lancado" } },
    { id: "i2", ctrc: "C2-2", snapshot_hash: null, lancamento_ativo: { id: "L2", codigo_oc: 36, status: "lancado" } },
    { id: "i3", ctrc: "C3-3", snapshot_hash: null, lancamento_ativo: { id: "L3", codigo_oc: 36, status: "fila" } },
  ];
  const p = plano({
    pendencias: [pend({ ctrc: "C1-1", cod_ultima_ocorrencia: 36 }), pend({ ctrc: "C2-2", cod_ultima_ocorrencia: 13 }), pend({ ctrc: "C3-3", cod_ultima_ocorrencia: 36 })],
    itensAbertos: abertos,
  });
  assertEquals(p.confirmar, [{ lancamento_id: "L1", oc_vista: 36 }]);
});

Deno.test("sugestão em SOMBRA: tabela padrão vazia não sugere nada; regra injetada sugere e marca lancavel pela lista", () => {
  assertEquals(plano({ pendencias: [pend({ ctrc: "G1-1" })] }).upserts[0]!.sugestao, null);
  const regras: RegraSugestaoOperacao[] = [{ id: "r36", descricao: "parada na base", quando: { ocs: [13], horasParadoMin: 24 }, sugerir: { codigo: 36, texto: "chegou na base" } }];
  const p = plano({ pendencias: [pend({ ctrc: "G1-1" })], regrasSugestao: regras, codigosLancaveisAtivos: new Set([36]) });
  assertEquals(p.upserts[0]!.sugestao?.codigo, 36);
  assertEquals(p.upserts[0]!.sugestao?.lancavel, true);
  const q = plano({ pendencias: [pend({ ctrc: "G1-1" })], regrasSugestao: regras });
  assertEquals(q.upserts[0]!.sugestao?.lancavel, false);
});

// ── orquestração ────────────────────────────────────────────────────────────

function repoFake(over: Partial<RepoMaterializacao> = {}) {
  const chamadas: string[] = [];
  const lotes: unknown[] = [];
  const rodadas: Array<{ ok: boolean }> = [];
  const repo: RepoMaterializacao = {
    flagLigada: (k) => { chamadas.push(`flag:${k}`); return Promise.resolve(true); },
    codigosOperacao: () => Promise.resolve([13, 36]),
    ctrcsComCardAtivo: () => Promise.resolve(new Set(["CARD-1"])),
    itensAbertos: () => Promise.resolve([]),
    encerradosPorCtrc24h: () => Promise.resolve(new Map()),
    regrasUnidade: () => Promise.resolve([REGRA_ATUAL]),
    codigosLancaveisAtivos: () => Promise.resolve(new Set()),
    aplicar: (l) => { lotes.push(l); return Promise.resolve({ criados: l.upserts.length }); },
    registrarRodada: (r) => { rodadas.push(r); return Promise.resolve(); },
    ...over,
  };
  return { repo, chamadas, lotes, rodadas };
}

Deno.test("FLAG OFF: nada é lido (nem Bastão) e nada é gravado", async () => {
  const f = repoFake({ flagLigada: () => Promise.resolve(false) });
  let bastao = 0;
  const r = await rodarMaterializacao({ repo: f.repo, bastao: { fetchPendenciasDaOperacao: () => { bastao++; return Promise.resolve({ pendencias: [], completo: true, erro: null }); } } });
  assertEquals(r.skipped, "flag_off");
  assertEquals(bastao, 0);
  assertEquals(f.lotes.length, 0);
  assertEquals(f.rodadas.length, 0);
});

Deno.test("rodada: aplica em lotes de 200, exclui card ativo e registra a rodada", async () => {
  const f = repoFake();
  const pendencias = [...Array.from({ length: 450 }, (_, i) => pend({ ctrc: `N${i}-1` })), pend({ ctrc: "CARD-1" })];
  const r = await rodarMaterializacao({ repo: f.repo, bastao: { fetchPendenciasDaOperacao: () => Promise.resolve({ pendencias, completo: true, erro: null }) } });
  assert(r.ok);
  assertEquals(f.lotes.length, 3);
  assertEquals(r.aplicado.criados, 450);
  assertEquals(r.ignorados.card_relacionamento_ativo, 1);
  assertEquals(f.rodadas.map((x) => x.ok), [true]);
});

Deno.test("fail-closed: sem a lista de cards ativos (erro) a rodada não grava nada", async () => {
  const f = repoFake({ ctrcsComCardAtivo: () => Promise.reject(new Error("timeout")) });
  const r = await rodarMaterializacao({ repo: f.repo, bastao: { fetchPendenciasDaOperacao: () => Promise.resolve({ pendencias: [pend({ ctrc: "X-1" })], completo: true, erro: null }) } });
  assertEquals(r.ok, false);
  assertEquals(f.lotes.length, 0);
  assertEquals(f.rodadas.map((x) => x.ok), [false]);
});

Deno.test("Bastão fora do ar (0 linhas e incompleto) → rodada falha sem gravar; dicionário vazio → aborta", async () => {
  const f = repoFake();
  const r = await rodarMaterializacao({ repo: f.repo, bastao: { fetchPendenciasDaOperacao: () => Promise.resolve({ pendencias: [], completo: false, erro: "503" }) } });
  assertEquals(r.ok, false);
  assertEquals(f.lotes.length, 0);
  const g = repoFake({ codigosOperacao: () => Promise.resolve([]) });
  const r2 = await rodarMaterializacao({ repo: g.repo, bastao: { fetchPendenciasDaOperacao: () => Promise.resolve({ pendencias: [pend({ ctrc: "X-1" })], completo: true, erro: null }) } });
  assertEquals(r2.ok, false);
  assertEquals(g.lotes.length, 0);
});
