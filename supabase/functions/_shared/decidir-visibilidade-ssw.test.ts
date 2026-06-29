// =============================================================================
// Testes da função-mãe de visibilidade (PR1 — escopo v3-LIMITED).
//
// PR1a — testes PUROS de `decidirVisibilidadePorSsw` (inputs → DECISÃO).
// PR1b — testes do mapeamento decisão → estado final + evento, por caller.
//
// ⚠️ ESTADO ESPERADO NESTA RODADA: VERMELHO. O corpo da função (PR2) e do
// mapeamento (PR4) é um STUB que lança erro. Estes testes encodam o CONTRATO
// aprovado (plano v3, matriz P1–P13) e ficam verdes quando PR2/PR4 preencherem.
//
// Rodar: deno test supabase/functions/_shared/decidir-visibilidade-ssw.test.ts
//
// Códigos reais (verdade-terreno do dicionário):
//   Relacionamento ≠54: 19,20,10,11,35,23,43,49 (e 3,8,17,26,28,57)
//   54 = AGUARDANDO_CLIENTE (caso especial)
//   Fora de escopo (NÃO-relacionamento): 56 (Operação), 14 (Operação), 7 (sistema),
//     33 (reversão de perdas → Perdas). 33 é lançada PELO Cockpit para transferir.
// =============================================================================

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ArgsVisibilidade,
  type CallerVisibilidade,
  decidirVisibilidadePorSsw,
  type DecisaoVisibilidade,
  estadoFinalParaDecisao,
  normalizarAutor,
  type OcorrenciaSsw,
} from "./decidir-visibilidade-ssw.ts";

// Conjunto de Relacionamento ≠54 (54 é caso especial tratado ANTES do ehRelac).
const RELAC_SEM_54 = new Set([3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49, 57]);
const ehRelac = (oc: number) => RELAC_SEM_54.has(oc);
const COCKPIT = "ai.salex";

function args(
  ocs: Array<[number | null, string | null]>,
  codigoUltimoLancamentoCockpit: number | null,
  sswFresco = true,
): ArgsVisibilidade {
  const ocorrenciasSsw: OcorrenciaSsw[] = ocs.map(([codigo, usuario]) => ({ codigo, usuario }));
  return { ocorrenciasSsw, ehRelac, contaLancamentoCockpit: COCKPIT, codigoUltimoLancamentoCockpit, sswFresco };
}

function decisao(a: ArgsVisibilidade): DecisaoVisibilidade {
  return decidirVisibilidadePorSsw(a).decisao;
}

// --- normalizarAutor: este já tem corpo (não é stub) — pode ficar VERDE ---------
Deno.test("normalizarAutor: lower + trim", () => {
  assertEquals(normalizarAutor(" AI.Salex "), "ai.salex");
  assertEquals(normalizarAutor(null), "");
  assertEquals(normalizarAutor("ai.salex"), "ai.salex");
});

// =============================================================================
// PR1a — TESTES PUROS (input → decisão). Matriz P1–P13 do plano v3.
// =============================================================================

Deno.test("P1 — NF 346896: topo oc19 (terceiro) acima de oc56 (Cockpit) → MOSTRAR_OPERADOR", () => {
  assertEquals(decisao(args([[19, "marianep"], [56, COCKPIT]], 56)), "MOSTRAR_OPERADOR");
});

Deno.test("P2 — bounce-back 351193: topo oc56 (não-relac, Cockpit) → MANTER_FORA_RELACIONAMENTO", () => {
  assertEquals(decisao(args([[56, COCKPIT], [49, "op"]], 56)), "MANTER_FORA_RELACIONAMENTO");
});

Deno.test("P3 — oc54 lançada pelo Cockpit → AGUARDANDO_CLIENTE", () => {
  assertEquals(decisao(args([[54, COCKPIT]], 54)), "AGUARDANDO_CLIENTE");
});

Deno.test("P4 — oc54 lançada por TERCEIRO também → AGUARDANDO_CLIENTE", () => {
  assertEquals(decisao(args([[54, "op_terceiro"]], null)), "AGUARDANDO_CLIENTE");
});

Deno.test("P5 — relac≠54 (oc49) no topo MAS é ação do Cockpit → MANTER_FORA_RELACIONAMENTO", () => {
  assertEquals(decisao(args([[49, COCKPIT], [19, "op"]], 49)), "MANTER_FORA_RELACIONAMENTO");
});

Deno.test("P6 — autor com MAIÚSCULA/espaços normaliza p/ ai.salex → MANTER_FORA_RELACIONAMENTO", () => {
  assertEquals(decisao(args([[19, " AI.Salex "]], 19)), "MANTER_FORA_RELACIONAMENTO");
});

Deno.test("P7 — terceiro lançou relac≠54 (oc20) após ação não-relac do Cockpit (oc33) → MOSTRAR_OPERADOR", () => {
  // oc33 = reversão de perdas (FORA de escopo), lançada pelo Cockpit p/ transferir.
  assertEquals(decisao(args([[20, "terceiro"], [33, COCKPIT]], 33)), "MOSTRAR_OPERADOR");
});

Deno.test("P8 — mesmo código (49) por terceiro E por ai.salex; identidade do TOPO=terceiro → MOSTRAR_OPERADOR", () => {
  assertEquals(decisao(args([[49, "terceiro"], [49, COCKPIT]], 49)), "MOSTRAR_OPERADOR");
});

Deno.test("P9 — autor desconhecido + código igual ao último lançamento NÃO esconde → INDEFINIDO_RETRY", () => {
  // Regra-chave (ajuste #2): código igual NÃO é fingerprint forte. Nunca MANTER_FORA.
  assertEquals(decisao(args([[49, ""], [19, "op"]], 49)), "INDEFINIDO_RETRY");
});

Deno.test("P10 — autor desconhecido SEM evidência de ser nossa → MOSTRAR_OPERADOR (dúvida mostra)", () => {
  assertEquals(decisao(args([[20, ""], [14, "op"]], null)), "MOSTRAR_OPERADOR");
});

Deno.test("P11 — cache stale divergente (sswFresco=false) NUNCA esconde → INDEFINIDO_RETRY", () => {
  assertEquals(decisao(args([[56, COCKPIT]], 56, /* sswFresco */ false)), "INDEFINIDO_RETRY");
});

Deno.test("P12 — SSW indisponível (sem ocorrência) → INDEFINIDO_RETRY", () => {
  assertEquals(decisao(args([], 49)), "INDEFINIDO_RETRY");
});

Deno.test("P13 — só linhas sem código (nenhuma oc codificada) → INDEFINIDO_RETRY", () => {
  assertEquals(decisao(args([[null, "op"], [null, "sistema"]], 49)), "INDEFINIDO_RETRY");
});

// =============================================================================
// PR1b — MAPEAMENTO decisão → estado final + evento, por caller (CONTRATO DE PR4).
// (A função pura NÃO conhece estado/evento; quem mapeia é o caller — Pass A / sweep.)
//
// ⚠️ IGNORADOS POR PADRÃO: `estadoFinalParaDecisao` só ganha corpo no PR4 (integração
// dos callers). Marcados `ignore: PENDENTE_PR4` para o suite padrão ficar VERDE
// (PR1a + função pura). Quando PR4 integrar, basta flipar `PENDENTE_PR4 = false`.
// =============================================================================

const PENDENTE_PR4 = false; // PR4: estadoFinalParaDecisao implementado → PR1b ativo

function mapa(d: DecisaoVisibilidade, c: CallerVisibilidade) {
  return estadoFinalParaDecisao(d, c);
}

Deno.test({ name: "PR1b [PR4] — MOSTRAR_OPERADOR / Pass A → AVH+lock + CardReaberto", ignore: PENDENTE_PR4 }, () => {
  assertEquals(mapa("MOSTRAR_OPERADOR", "passA"), {
    state: "AGUARDANDO_VALIDACAO_HUMANA",
    lock: true,
    evento: "CardReaberto",
  });
});

Deno.test({ name: "PR1b [PR4] — MOSTRAR_OPERADOR / sweep INV-019 → AVH+lock + CardReaberto", ignore: PENDENTE_PR4 }, () => {
  assertEquals(mapa("MOSTRAR_OPERADOR", "sweepInv019"), {
    state: "AGUARDANDO_VALIDACAO_HUMANA",
    lock: true,
    evento: "CardReaberto",
  });
});

Deno.test({ name: "PR1b [PR4] — Pass A (card TRANSFERIDO) + decisão AGUARDANDO_CLIENTE → AGUARDANDO_CLIENTE (lock=false) + evento, NUNCA manter TRANSFERIDO", ignore: PENDENTE_PR4 }, () => {
  assertEquals(mapa("AGUARDANDO_CLIENTE", "passA"), {
    state: "AGUARDANDO_CLIENTE",
    lock: false,
    evento: "AguardandoClienteForcadoPorSsw",
  });
});

Deno.test({ name: "PR1b [PR4] — AGUARDANDO_CLIENTE / sweep INV-019 → inalterado (card já está em AC)", ignore: PENDENTE_PR4 }, () => {
  assertEquals(mapa("AGUARDANDO_CLIENTE", "sweepInv019"), {
    state: null,
    lock: null,
    evento: null,
  });
});

Deno.test({ name: "PR1b [PR4] — MANTER_FORA_RELACIONAMENTO / Pass A → inalterado + ReaberturaSuprimida", ignore: PENDENTE_PR4 }, () => {
  assertEquals(mapa("MANTER_FORA_RELACIONAMENTO", "passA"), {
    state: null,
    lock: null,
    evento: "ReaberturaSuprimida",
  });
});

Deno.test({ name: "PR1b [PR4] — MANTER_FORA_RELACIONAMENTO / sweep INV-019 → inalterado (não rebaixa) + ReaberturaSuprimida", ignore: PENDENTE_PR4 }, () => {
  assertEquals(mapa("MANTER_FORA_RELACIONAMENTO", "sweepInv019"), {
    state: null,
    lock: null,
    evento: "ReaberturaSuprimida",
  });
});

Deno.test({ name: "PR1b [PR4] — INDEFINIDO_RETRY / Pass A → inalterado este ciclo + ReaberturaIndefinida (dispara prazo)", ignore: PENDENTE_PR4 }, () => {
  assertEquals(mapa("INDEFINIDO_RETRY", "passA"), {
    state: null,
    lock: null,
    evento: "ReaberturaIndefinida",
  });
});

Deno.test({ name: "PR1b [PR4] — INDEFINIDO_RETRY / sweep INV-019 → inalterado este ciclo + ReaberturaIndefinida", ignore: PENDENTE_PR4 }, () => {
  assertEquals(mapa("INDEFINIDO_RETRY", "sweepInv019"), {
    state: null,
    lock: null,
    evento: "ReaberturaIndefinida",
  });
});
