// Guard — setores na fila da Operação (mig 441; ADR 0042; ADR 0041 D2/D4).
// Fonte das regras: o Pendências (tatiana-kelly/pendency-tracker@a884368,
// src/types/pendencia.ts:63-86 e etl/notas-ciclo/src/setores.js:44-58).
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/operacao-setores.test.ts
//
// Trava:
//   - sem a 441 (repo sem setoresNaFila, vazio ou com erro) o materializador faz
//     EXATAMENTE o de antes: só OPERACAO pelo dicionário, mesmo filtro do Bastão;
//   - com AGENDAMENTO na fila: oc 31 com responsável vazio entra; oc 49 nunca;
//     responsável 'relacionamento' nunca; RELACIONAMENTO nunca entra nem se a config disser;
//   - a semente da mig 441 (op_setor_por_oc) = o mapa do front (setores.ts), lidos como texto.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { filtroOperacao } from "./bastao-operacao-client.ts";
import {
  ehDaOperacao,
  ehDosSetoresDaFila,
  type PendenciaOperacao,
  planejarMaterializacao,
  type RegraUnidade,
  type RepoMaterializacao,
  rodarMaterializacao,
  sanearSetoresNaFila,
  setorDaPendencia,
  type SetorNaFila,
} from "./operacao-materializar.ts";

const AGORA = Date.parse("2026-10-08T12:00:00Z");
const DICIONARIO_OPERACAO = new Set([1, 2, 13, 14, 15, 21, 32, 34, 36, 37, 41, 56]);
const REGRA_ATUAL: RegraUnidade = { codigo_oc: null, campo_bastao: "unidade_atual", prioridade: 100, ativo: true };

function pend(o: Partial<PendenciaOperacao> & { ctrc: string }): PendenciaOperacao {
  return {
    id: `b-${o.ctrc}`, nf: "000001234", filial: "VGA", cod_ultima_ocorrencia: 13, instrucao_ultima_ocorrencia: null,
    data_ultima_ocorrencia: "2026-10-06T10:00:00Z", responsavel_atual: null, pagador: "P", cnpj_pagador: "1",
    destinatario: "D", cidade_destino: "Varginha", uf_destino: "MG", base_destino: "VGA", unidade_origem: "BHZ",
    unidade_destino: "VGA", unidade_atual: "VGA", previsao_entrega: null, atraso_original: 2, qtd_volumes: 3, ...o,
  };
}

// ── o mapa: migration 441 × front ─────────────────────────────────────────────

const RAIZ = new URL("../../../", import.meta.url);
const MIG_441 = new URL("migration/2026-10-08_441_operacao_setores.sql", RAIZ);
const SETORES_TS = new URL("apps/cockpit-web/src/lib/operacao/setores.ts", RAIZ);

/** Linhas `(<cod>, '<SETOR>', ...)` da semente de op_setor_por_oc → setor → códigos. */
function semente441(sql: string): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const linha of sql.split("\n")) {
    const r = /^\s*\((\d+),\s*'([A-Z_]+)',\s*'/.exec(linha);
    if (!r) continue;
    const lista = m.get(r[2]) ?? [];
    lista.push(Number(r[1]));
    m.set(r[2], lista);
  }
  for (const l of m.values()) l.sort((a, b) => a - b);
  return m;
}

/** `id: "X"` ... `codigos: [..]` de cada SetorDef do front (lido como TEXTO, sem importar). */
function mapaDoFront(ts: string): Map<string, number[]> {
  const m = new Map<string, number[]>();
  const re = /id:\s*"([A-Z_]+)"[\s\S]*?codigos:\s*\[([^\]]*)\]/g;
  for (const r of ts.matchAll(re)) {
    const cods = r[2].split(",").map((x) => x.trim()).filter(Boolean).map(Number);
    m.set(r[1], cods.sort((a, b) => a - b));
  }
  return m;
}

function porSetor(m: Map<string, number[]>): Record<string, number[]> {
  return Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)));
}

const ESPERADO: Record<string, number[]> = {
  AGENDAMENTO: [31],
  CLIENTE: [54, 59, 60],
  DEVOLUCAO: [30, 44, 53, 58],
  OPERACAO: [1, 2, 4, 5, 7, 12, 13, 14, 15, 21, 22, 24, 25, 27, 29, 32, 34, 36, 37, 38, 39, 40, 41, 45, 48, 50, 51, 52, 55, 56, 57],
  PERDAS: [6, 9, 16],
  RELACIONAMENTO: [3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49],
  RESSARCIMENTO: [18, 33, 42, 46, 47],
};

Deno.test("mapa: a semente da mig 441 é o mapa do Pendências (52→OPERACAO, 60→CLIENTE), 60 ocs, sem repetição", async () => {
  const sem = semente441(await Deno.readTextFile(MIG_441));
  assertEquals(porSetor(sem), ESPERADO);
  const todos = [...sem.values()].flat().sort((a, b) => a - b);
  assertEquals(todos, Array.from({ length: 60 }, (_, i) => i + 1));
});

Deno.test("mapa: mig 441 = apps/cockpit-web/src/lib/operacao/setores.ts (lido como texto)", async () => {
  const sem = semente441(await Deno.readTextFile(MIG_441));
  const front = mapaDoFront(await Deno.readTextFile(SETORES_TS));
  assertEquals(front.size, 7);
  assertEquals(porSetor(front), porSetor(sem));
});

// ── setor da pendência ──────────────────────────────────────────────────────────

const MAPA_COMPLETO = new Map<number, string>(Object.entries(ESPERADO).flatMap(([s, cs]) => cs.map((c) => [c, s] as [number, string])));

Deno.test("setorDaPendencia: responsável conhecido > mapa > NAO_IDENTIFICADO (= op_setor_do_item)", () => {
  assertEquals(setorDaPendencia({ responsavel_atual: null, cod_ultima_ocorrencia: 13 }, MAPA_COMPLETO), "OPERACAO");
  assertEquals(setorDaPendencia({ responsavel_atual: "", cod_ultima_ocorrencia: 31 }, MAPA_COMPLETO), "AGENDAMENTO");
  assertEquals(setorDaPendencia({ responsavel_atual: "relacionamento", cod_ultima_ocorrencia: 13 }, MAPA_COMPLETO), "RELACIONAMENTO");
  assertEquals(setorDaPendencia({ responsavel_atual: " Operação ", cod_ultima_ocorrencia: 49 }, MAPA_COMPLETO), "OPERACAO");
  assertEquals(setorDaPendencia({ responsavel_atual: "DEVOLUÇÃO", cod_ultima_ocorrencia: null }, MAPA_COMPLETO), "DEVOLUCAO");
  // desconhecido NÃO cai no mapa: fica NAO_IDENTIFICADO (mesma exclusão do ehDaOperacao antigo)
  assertEquals(setorDaPendencia({ responsavel_atual: "indenizacao", cod_ultima_ocorrencia: 13 }, MAPA_COMPLETO), "NAO_IDENTIFICADO");
  assertEquals(setorDaPendencia({ responsavel_atual: "indenizacao", cod_ultima_ocorrencia: 999 }, MAPA_COMPLETO), "NAO_IDENTIFICADO");
  assertEquals(setorDaPendencia({ responsavel_atual: null, cod_ultima_ocorrencia: null }, MAPA_COMPLETO), "NAO_IDENTIFICADO");
});

const COM_AGENDAMENTO: SetorNaFila[] = [
  { setor: "OPERACAO", codigos: ESPERADO.OPERACAO },
  { setor: "AGENDAMENTO", codigos: ESPERADO.AGENDAMENTO },
];
const nomes = (s: SetorNaFila[]) => s.map((x) => x.setor);
const cods = (s: SetorNaFila[]) => new Map(s.map((x) => [x.setor, x.codigos] as const));

Deno.test("ehDosSetoresDaFila: com AGENDAMENTO, a 31 vazia entra; a 49 e 'relacionamento' nunca", () => {
  const dentro = (p: Pick<PendenciaOperacao, "responsavel_atual" | "cod_ultima_ocorrencia">) =>
    ehDosSetoresDaFila(p, nomes(COM_AGENDAMENTO), cods(COM_AGENDAMENTO));
  assert(dentro({ responsavel_atual: null, cod_ultima_ocorrencia: 31 }));
  assert(dentro({ responsavel_atual: "agendamento", cod_ultima_ocorrencia: 13 }));
  assert(dentro({ responsavel_atual: null, cod_ultima_ocorrencia: 13 }));
  assert(!dentro({ responsavel_atual: null, cod_ultima_ocorrencia: 49 }));
  assert(!dentro({ responsavel_atual: "relacionamento", cod_ultima_ocorrencia: 31 }));
  assert(!dentro({ responsavel_atual: "relacionamento", cod_ultima_ocorrencia: 13 }));
  assert(!dentro({ responsavel_atual: "devolucao", cod_ultima_ocorrencia: 31 }));  // setor fora da fila
  assert(!dentro({ responsavel_atual: null, cod_ultima_ocorrencia: 30 }));
});

Deno.test("RELACIONAMENTO nunca entra, nem se a config disser (código e saneamento)", () => {
  const cfg: SetorNaFila[] = [{ setor: "RELACIONAMENTO", codigos: ESPERADO.RELACIONAMENTO }, { setor: "operacao", codigos: [13] }];
  assertEquals(sanearSetoresNaFila(cfg), [{ setor: "OPERACAO", codigos: [13] }]);
  assert(!ehDosSetoresDaFila({ responsavel_atual: null, cod_ultima_ocorrencia: 49 }, nomes(cfg), cods(cfg)));
  assert(!ehDosSetoresDaFila({ responsavel_atual: "relacionamento", cod_ultima_ocorrencia: 13 }, nomes(cfg), cods(cfg)));
  assertEquals(sanearSetoresNaFila([{ setor: "MOTORISTA", codigos: [1] }, { setor: "RELACIONAMENTO", codigos: [49] }]), []);
  assertEquals(sanearSetoresNaFila(null), []);
});

Deno.test("ehDaOperacao (wrapper) = ehDosSetoresDaFila só com OPERACAO e o dicionário", () => {
  const casos: Array<Pick<PendenciaOperacao, "responsavel_atual" | "cod_ultima_ocorrencia">> = [
    { responsavel_atual: "operacao", cod_ultima_ocorrencia: 54 }, { responsavel_atual: " Operação ", cod_ultima_ocorrencia: null },
    { responsavel_atual: "relacionamento", cod_ultima_ocorrencia: 13 }, { responsavel_atual: "cliente", cod_ultima_ocorrencia: 13 },
    { responsavel_atual: null, cod_ultima_ocorrencia: 13 }, { responsavel_atual: "", cod_ultima_ocorrencia: 49 },
    { responsavel_atual: null, cod_ultima_ocorrencia: 31 }, { responsavel_atual: null, cod_ultima_ocorrencia: null },
  ];
  for (const c of casos) {
    assertEquals(ehDaOperacao(c, DICIONARIO_OPERACAO),
      ehDosSetoresDaFila(c, ["OPERACAO"], new Map([["OPERACAO", DICIONARIO_OPERACAO]])), JSON.stringify(c));
  }
});

// ── filtro do Bastão ──────────────────────────────────────────────────────────────

Deno.test("filtro do Bastão: só 'operacao' = o texto de antes; mais setores = in.(...); nunca relacionamento", () => {
  const antes = "(responsavel_atual.eq.operacao,and(responsavel_atual.is.null,cod_ultima_ocorrencia.in.(13,36)))";
  assertEquals(filtroOperacao([36, 13]), antes);
  assertEquals(filtroOperacao([36, 13], ["operacao"]), antes);
  assertEquals(filtroOperacao([36, 13], ["operacao", "relacionamento"]), antes);
  assertEquals(filtroOperacao([31, 13], ["operacao", "agendamento"]),
    "(responsavel_atual.in.(agendamento,operacao),and(responsavel_atual.is.null,cod_ultima_ocorrencia.in.(13,31)))");
  assertEquals(filtroOperacao([31], ["AGENDAMENTO"]), "(responsavel_atual.eq.agendamento,and(responsavel_atual.is.null,cod_ultima_ocorrencia.in.(31)))");
  assertEquals(filtroOperacao([], ["relacionamento"]), "(responsavel_atual.eq.operacao)");
});

// ── plano e rodada ───────────────────────────────────────────────────────────────

function plano(p: Partial<Parameters<typeof planejarMaterializacao>[0]>) {
  return planejarMaterializacao({
    pendencias: [], codigosOperacao: DICIONARIO_OPERACAO, ctrcsComCardAtivo: new Set(), itensAbertos: [],
    encerradosPorCtrc24h: new Map(), regrasUnidade: [REGRA_ATUAL], codigosLancaveisAtivos: new Set(), agoraMs: AGORA, ...p,
  });
}

const PENDENCIAS = [
  pend({ ctrc: "OP-1", cod_ultima_ocorrencia: 13 }),
  pend({ ctrc: "AG-1", cod_ultima_ocorrencia: 31 }),
  pend({ ctrc: "AG-2", cod_ultima_ocorrencia: 13, responsavel_atual: "agendamento" }),
  pend({ ctrc: "REL-1", cod_ultima_ocorrencia: 49 }),
  pend({ ctrc: "REL-2", cod_ultima_ocorrencia: 13, responsavel_atual: "relacionamento" }),
  pend({ ctrc: "OPR-1", cod_ultima_ocorrencia: 36, responsavel_atual: "operacao" }),
];

Deno.test("plano: sem setoresNaFila (ou vazio) = o de antes, só OPERACAO pelo dicionário", () => {
  for (const setoresNaFila of [undefined, [] as SetorNaFila[], [{ setor: "RELACIONAMENTO", codigos: [49] }]]) {
    const p = plano({ pendencias: PENDENCIAS, setoresNaFila });
    assertEquals(p.upserts.map((u) => u.ctrc).sort(), ["OP-1", "OPR-1"]);
    assertEquals(p.ignorados.nao_e_da_operacao, 4);
  }
});

Deno.test("plano: com AGENDAMENTO na fila entram a 31 vazia e o responsável agendamento; 49 e relacionamento nunca", () => {
  const p = plano({ pendencias: PENDENCIAS, setoresNaFila: COM_AGENDAMENTO });
  assertEquals(p.upserts.map((u) => u.ctrc).sort(), ["AG-1", "AG-2", "OP-1", "OPR-1"]);
  assertEquals(p.ignorados.nao_e_da_operacao, 2);
});

Deno.test("plano: reterFechamento não encerra nada por 'saiu'", () => {
  const p = plano({
    pendencias: [pend({ ctrc: "OP-1" })],
    itensAbertos: [{ id: "i-ag", ctrc: "AG-1", snapshot_hash: null, lancamento_ativo: null }],
    reterFechamento: "setores da fila indisponíveis",
  });
  assertEquals(p.encerrar, []);
  assert(p.fechamento_retido?.startsWith("setores da fila indisponíveis"));
});

function repoFake(over: Partial<RepoMaterializacao> = {}) {
  const lotes: Array<{ upserts: Array<{ ctrc: string }>; encerrar: unknown[] }> = [];
  const repo: RepoMaterializacao = {
    flagLigada: () => Promise.resolve(true),
    codigosOperacao: () => Promise.resolve([13, 36]),
    ctrcsComCardAtivo: () => Promise.resolve(new Set()),
    itensAbertos: () => Promise.resolve([]),
    encerradosPorCtrc24h: () => Promise.resolve(new Map()),
    regrasUnidade: () => Promise.resolve([REGRA_ATUAL]),
    codigosLancaveisAtivos: () => Promise.resolve(new Set()),
    aplicar: (l) => { lotes.push(l); return Promise.resolve({ criados: l.upserts.length }); },
    registrarRodada: () => Promise.resolve(),
    ...over,
  };
  return { repo, lotes };
}

function bastaoFake() {
  const pedidos: Array<{ codigosOperacao: readonly number[]; setores?: readonly string[] }> = [];
  return {
    pedidos,
    bastao: {
      fetchPendenciasDaOperacao(opts: { codigosOperacao: readonly number[]; setores?: readonly string[] }) {
        pedidos.push(opts);
        return Promise.resolve({ pendencias: PENDENCIAS, completo: true, erro: null });
      },
    },
  };
}

Deno.test("rodada padrão (repo sem setoresNaFila): pedido ao Bastão e resultado IDÊNTICOS ao de antes", async () => {
  const f = repoFake();
  const b = bastaoFake();
  const r = await rodarMaterializacao({ repo: f.repo, bastao: b.bastao });
  assert(r.ok);
  assertEquals(b.pedidos, [{ codigosOperacao: [13, 36] }]);  // sem `setores`: o adaptador usa 'operacao'
  assertEquals(f.lotes[0].upserts.map((u) => u.ctrc).sort(), ["OP-1", "OPR-1"]);
  assertEquals("setores_na_fila" in r, false);
});

Deno.test("rodada: setoresNaFila vazio (441 sem nada ligado) ou que falha = só OPERACAO; a falha retém o fechamento", async () => {
  const vazio = repoFake({ setoresNaFila: () => Promise.resolve([]) });
  const b1 = bastaoFake();
  const r1 = await rodarMaterializacao({ repo: vazio.repo, bastao: b1.bastao });
  assertEquals(b1.pedidos, [{ codigosOperacao: [13, 36] }]);
  assertEquals(vazio.lotes[0].upserts.map((u) => u.ctrc).sort(), ["OP-1", "OPR-1"]);
  assertEquals(r1.setores_na_fila, ["OPERACAO"]);

  const falha = repoFake({
    setoresNaFila: () => Promise.reject(new Error("timeout")),
    itensAbertos: () => Promise.resolve([{ id: "i-x", ctrc: "SUMIU-1", snapshot_hash: null, lancamento_ativo: null }]),
  });
  const b2 = bastaoFake();
  const r2 = await rodarMaterializacao({ repo: falha.repo, bastao: b2.bastao });
  assert(r2.ok);
  assertEquals(b2.pedidos, [{ codigosOperacao: [13, 36] }]);
  assertEquals(falha.lotes[0].encerrar, []);
  assert(r2.erros.some((e) => e.includes("setores na fila")));
  assert(r2.fechamento_retido !== null);
});

Deno.test("rodada com AGENDAMENTO ligado: Bastão recebe os dois setores e os códigos do mapa", async () => {
  const f = repoFake({
    setoresNaFila: () => Promise.resolve([...COM_AGENDAMENTO, { setor: "RELACIONAMENTO", codigos: [49] }]),
  });
  const b = bastaoFake();
  const r = await rodarMaterializacao({ repo: f.repo, bastao: b.bastao });
  assert(r.ok);
  assertEquals(b.pedidos.length, 1);
  assertEquals(b.pedidos[0].setores, ["operacao", "agendamento"]);
  assertEquals(b.pedidos[0].codigosOperacao, [...ESPERADO.OPERACAO, 31].sort((a, c) => a - c));
  assert(!b.pedidos[0].codigosOperacao.includes(49));
  assertEquals(f.lotes[0].upserts.map((u) => u.ctrc).sort(), ["AG-1", "AG-2", "OP-1", "OPR-1"]);
  assertEquals(r.setores_na_fila, ["OPERACAO", "AGENDAMENTO"]);
});
