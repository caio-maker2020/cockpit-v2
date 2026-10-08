// Guard — rodada da edge sugerir-operacao: regra → agente, cache, flags, auto-encaminhar
// (ADR 0041 D10/D11; INV-188/189). Sem rede (fetch falso). Rodar:
//   deno test --no-check --allow-read supabase/functions/_shared/operacao-sugerir-ia.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { chamarAgenteOperacao, montarEntradaAgente } from "./operacao-agente-sugestao.ts";
import {
  type CandidatoSugestaoIa,
  FLAG_OPERACAO_ENCAMINHAR_AUTO,
  FLAG_OPERACAO_SUGESTAO_IA,
  type GravarSugestaoIa,
  LIMIAR_ENCAMINHAR_AUTO_PISO,
  type RepoSugestaoIa,
  resolverJanelaAuto,
  resolverLimiarAuto,
  rodarSugestaoIa,
} from "./operacao-sugerir-ia.ts";
import type { RegraAprendidaOperacao } from "./operacao-sugestao.ts";

const cand = (id: string, oc = 13, unidade = "VGA"): CandidatoSugestaoIa => ({
  op_item_id: id, cod_ultima_ocorrencia: oc, data_ultima_ocorrencia: "2026-10-05T10:00:00Z", instrucao_ultima_ocorrencia: null,
  unidade, cidade_destino: "Varginha", uf_destino: "MG", pagador: "ACME",
});

function repoFake(o: { flags?: string[]; candidatos?: CandidatoSugestaoIa[]; regras?: RegraAprendidaOperacao[] } = {}) {
  const gravados: GravarSugestaoIa[] = [];
  const auto: Array<[number, number, number]> = [];
  let promovidos = 0;
  const repo: RepoSugestaoIa = {
    flagLigada: (k) => Promise.resolve((o.flags ?? []).includes(k)),
    candidatos: (lim) => Promise.resolve((o.candidatos ?? []).slice(0, lim)),
    codigosOperacao: () => Promise.resolve(new Map([[13, "Chegada"], [14, "Entrega iniciada"], [36, "Chegada na base"]])),
    descricoesOcorrencias: () => Promise.resolve(new Map([[13, "Chegada"]])),
    codigosLancaveisAtivos: () => Promise.resolve(new Set([36])),
    regrasAprendidas: () => Promise.resolve(o.regras ?? []),
    gravar: (g) => {
      gravados.push(g);
      return Promise.resolve(g.resultado.status === "ok" ? "gravada" : g.resultado.status);
    },
    encaminharAuto: (l, j, n) => {
      auto.push([l, j, n]);
      return Promise.resolve(2);
    },
    promoverEncaminhamentos: () => {
      promovidos++;
      return Promise.resolve({ enviado: 0 });
    },
  };
  return { repo, gravados, auto, promovidos: () => promovidos };
}

/** O agente de verdade (chamarAgenteOperacao) com fetch falso que conta as idas à API. */
function agenteComFetchFalso(texto: string) {
  let chamadas = 0;
  const f: typeof fetch = () => {
    chamadas++;
    return Promise.resolve(new Response(JSON.stringify({
      content: [{ type: "text", text: texto }], model: "claude-haiku-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    })));
  };
  return {
    chamadas: () => chamadas,
    agente: (c: CandidatoSugestaoIa, ctx: { codigosOperacao: Map<number, string>; lancaveis: Set<number> }) =>
      chamarAgenteOperacao({
        apiKey: "k", fetch: f, codigosLancaveisAtivos: ctx.lancaveis,
        entrada: montarEntradaAgente({ item: c, codigosOperacao: ctx.codigosOperacao, historico: [], agoraMs: Date.parse("2026-10-07T12:00:00Z") }),
      }),
  };
}
const RESPOSTA_OK = JSON.stringify({ acao: "lancar_ocorrencia", codigo: 36, texto: "chegou na base", confianca: 0.7, justificativa: "j" });

Deno.test("flag operacao_sugestao_ia OFF → nenhuma chamada à IA (mas os encaminhamentos agendados são promovidos)", async () => {
  const fk = repoFake({ candidatos: [cand("a")] });
  const ag = agenteComFetchFalso(RESPOSTA_OK);
  const r = await rodarSugestaoIa({ repo: fk.repo, agente: ag.agente });
  assertEquals([r.ia, r.auto, ag.chamadas(), fk.gravados.length, fk.promovidos()], ["flag_off", "flag_off", 0, 0, 1]);
});

Deno.test("casa regra → NÃO chama a IA; sem regra → chama e grava no cache (item, oc)", async () => {
  const regras: RegraAprendidaOperacao[] = [{
    id: "h13", estado: { oc: 13, unidade: "VGA" }, acao: "lancar_ocorrencia", codigo: 14, texto: "saiu para entrega",
    confianca: 0.9, casos: 30, base_regra: "hist",
  }];
  const fk = repoFake({ flags: [FLAG_OPERACAO_SUGESTAO_IA], candidatos: [cand("com-regra"), cand("sem-regra", 13, "POU")], regras });
  const ag = agenteComFetchFalso(RESPOSTA_OK);
  const r = await rodarSugestaoIa({ repo: fk.repo, agente: ag.agente });
  assertEquals([r.regra_casou, r.chamadas, ag.chamadas()], [1, 1, 1]);
  assertEquals(fk.gravados.map((g) => [g.op_item_id, g.oc, g.resultado.status]), [["sem-regra", 13, "ok"]]);
  assertEquals(fk.gravados[0]!.resultado.sugestao?.base_regra, "agente_ia");
});

Deno.test("código proibido / JSON inválido / timeout → gravados como sem sugestão (cache), a rodada segue", async () => {
  for (const [texto, status] of [
    [JSON.stringify({ acao: "lancar_ocorrencia", codigo: 49, texto: "tratativa", confianca: 0.9 }), "descartada"],
    ["isso não é json", "descartada"],
  ] as const) {
    const fk = repoFake({ flags: [FLAG_OPERACAO_SUGESTAO_IA], candidatos: [cand("a"), cand("b")] });
    const ag = agenteComFetchFalso(texto);
    const r = await rodarSugestaoIa({ repo: fk.repo, agente: ag.agente });
    assertEquals(fk.gravados.map((g) => [g.resultado.status, g.resultado.sugestao]), [[status, null], [status, null]]);
    assertEquals(r.por_status[status], 2);
  }
  const fk = repoFake({ flags: [FLAG_OPERACAO_SUGESTAO_IA], candidatos: [cand("a")] });
  const lento: typeof fetch = (_i, init) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("abort"))));
  const r = await rodarSugestaoIa({
    repo: fk.repo,
    agente: (c, ctx) => chamarAgenteOperacao({
      apiKey: "k", fetch: lento, timeoutMs: 20, codigosLancaveisAtivos: ctx.lancaveis,
      entrada: montarEntradaAgente({ item: c, codigosOperacao: ctx.codigosOperacao, historico: [], agoraMs: Date.now() }),
    }),
  });
  assertEquals([r.por_status.falha, fk.gravados[0]!.resultado.motivo, r.erros], [1, "timeout", []]);
});

Deno.test("teto de chamadas e de tempo por rodada (custo)", async () => {
  const cands = Array.from({ length: 30 }, (_, i) => cand(`c${i}`, 13, "POU"));
  const fk = repoFake({ flags: [FLAG_OPERACAO_SUGESTAO_IA], candidatos: cands });
  const ag = agenteComFetchFalso(RESPOSTA_OK);
  const r = await rodarSugestaoIa({ repo: fk.repo, agente: ag.agente, limiteChamadas: 4 });
  assertEquals([r.chamadas, ag.chamadas()], [4, 4]);
  let t = 0;
  const fk2 = repoFake({ flags: [FLAG_OPERACAO_SUGESTAO_IA], candidatos: cands });
  const r2 = await rodarSugestaoIa({ repo: fk2.repo, agente: ag.agente, agora: () => (t += 50_000), orcamentoMs: 120_000 });
  assert(r2.parou_por_tempo && r2.chamadas < 4, `chamadas=${r2.chamadas}`);
});

Deno.test("erro ao gravar um item não derruba a rodada", async () => {
  const fk = repoFake({ flags: [FLAG_OPERACAO_SUGESTAO_IA], candidatos: [cand("a", 13, "POU"), cand("b", 13, "POU")] });
  let n = 0;
  fk.repo.gravar = () => (++n === 1 ? Promise.reject(new Error("falhou")) : Promise.resolve("gravada"));
  const ag = agenteComFetchFalso(RESPOSTA_OK);
  const r = await rodarSugestaoIa({ repo: fk.repo, agente: ag.agente });
  assertEquals([r.chamadas, r.gravacao.gravada, r.erros.length], [2, 1, 1]);
});

Deno.test("auto-encaminhar: só com a flag; limiar e janela nunca abaixo do piso", async () => {
  const fk = repoFake({ flags: [FLAG_OPERACAO_ENCAMINHAR_AUTO] });
  const r = await rodarSugestaoIa({ repo: fk.repo, agente: () => Promise.reject(new Error("não devia chamar")), limiarAuto: 0.3, janelaAutoMin: 1 });
  assertEquals([r.auto, r.agendados_auto, r.ia], ["rodou", 2, "flag_off"]);
  assertEquals(fk.auto, [[LIMIAR_ENCAMINHAR_AUTO_PISO, 10, 20]]);
  assertEquals([resolverLimiarAuto("0.5"), resolverLimiarAuto("0.95"), resolverLimiarAuto("x"), resolverLimiarAuto("2")], [0.8, 0.95, 0.9, 1]);
  assertEquals([resolverJanelaAuto("3"), resolverJanelaAuto("45"), resolverJanelaAuto(undefined)], [10, 45, 30]);
});
