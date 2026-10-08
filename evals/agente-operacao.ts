// =============================================================================
// evals/agente-operacao.ts — eval do agente de sugestão da Operação (ADR 0041 D10;
// INV-188). Responde: "o agente sugere o próximo passo certo (código da Operação
// ou encaminhar ao Relacionamento) e NUNCA deixa passar código proibido?"
//
// Três modos:
//   --seco (padrão)   NENHUMA chamada à API. Passa cada caso pela validação de
//                     verdade (validarRespostaAgente) usando a `resposta_gravada`
//                     da fixture e confere o status esperado. Custo zero; roda no CI
//                     e no /verify-cockpit. Trava a CERCA, não o modelo.
//   --ao-vivo         Chama o modelo de verdade com ANTHROPIC_API_KEY_EVALS
//                     (INV-167: nunca a de produção), conta tokens e imprime o custo.
//                     Acima de 50 chamadas exige --confirmar-custo <USD>.
//   --casos <arq>     Em vez das fixtures sintéticas, lê casos REAIS de um JSONL
//                     exportado (sem acesso ao banco a partir daqui). Combina com
//                     --seco (precisa de resposta_gravada) ou --ao-vivo.
//
// Formato de um caso (fixture ou linha do JSONL):
//   { "id": "...", "item": { op_item_id, cod_ultima_ocorrencia, data_ultima_ocorrencia,
//       instrucao_ultima_ocorrencia, unidade, cidade_destino, uf_destino, pagador },
//     "historico": [RegraAprendidaOperacao…]?,           // top-3 do estado, se houver
//     "gabarito": { "acao": "lancar_ocorrencia"|"encaminhar_relacionamento"|"sem_sugestao", "codigo"?: n },
//     "resposta_gravada": "<texto do modelo>"?,           // obrigatório no --seco
//     "esperado_status": "ok"|"descartada"|"sem_sugestao"? }
// Casos reais: o gabarito é o que a Operação de fato fez a seguir (a próxima oc
// lançada no CTRC, ou "encaminhar" quando a nota foi para o Relacionamento). O
// export é uma consulta de leitura pelo trilho (scripts/dbq.py), feita pelo time do
// Cockpit — este script não abre conexão com banco nenhum.
//
// Uso:
//   deno run --allow-read evals/agente-operacao.ts                       # seco, fixtures
//   deno run --allow-read evals/agente-operacao.ts --casos reais.jsonl   # seco, reais com resposta gravada
//   deno run --allow-read --allow-env --allow-net evals/agente-operacao.ts --ao-vivo [--modelo claude-sonnet-4-6] \
//     [--casos reais.jsonl] [--limit N] [--confirmar-custo <USD>]
// =============================================================================

import { ContadorCusto, lerChaveEvals, portaoDeCusto } from "./_custo-evals.ts"; // INV-167
import {
  chamarAgenteOperacao,
  codigosPermitidosAgente,
  type ItemAgente,
  montarEntradaAgente,
  resolverModeloAgente,
  validarRespostaAgente,
} from "../supabase/functions/_shared/operacao-agente-sugestao.ts";
import {
  OCS_NUNCA_SUGERIR,
  type RegraAprendidaOperacao,
  type SugestaoOperacao,
} from "../supabase/functions/_shared/operacao-sugestao.ts";
import { AGENTE_OPERACAO_VERSION } from "../supabase/functions/_shared/prompts/agente-operacao.ts";

export interface CasoEval {
  id: string;
  descricao?: string;
  item: ItemAgente;
  historico?: RegraAprendidaOperacao[];
  gabarito: { acao: "lancar_ocorrencia" | "encaminhar_relacionamento" | "aguardar" | "sem_sugestao"; codigo?: number | null };
  resposta_gravada?: string;
  esperado_status?: "ok" | "descartada" | "sem_sugestao" | "falha";
}

/** Dicionário de referência das fixtures (códigos de responsabilidade 'Operação'). */
export const DICIONARIO_EVAL = new Map<number, string>([
  [1, "Mercadoria entregue"], [13, "Chegada na unidade"], [14, "Entrega iniciada / saiu para entrega"],
  [15, "Entrega impossibilitada: limitação da base"], [21, "Reentrega"], [36, "Chegada na base para entrega"],
  [37, "Problema no veículo"], [41, "Informação complementar"], [56, "Falta informação operacional"],
]);

export interface ResultadoCaso {
  id: string;
  status: string;
  sugestao: SugestaoOperacao | null;
  gabarito: CasoEval["gabarito"];
  esperado_status?: string;
}

export interface Placar {
  casos: number;
  status_esperado_ok: number;
  status_esperado_total: number;
  acerto_acao: number;
  acerto_codigo: number;
  com_gabarito_lancar: number;
  sem_sugestao: number;
  descartadas: number;
  falhas: number;
  /** TEM de ser 0: código proibido/41/56/01 que chegou a virar sugestão. */
  proibidos_que_passaram: number;
  /** Encaminhou o que era "aguardar" (o erro do 1.0.0 no treino real: oc 41 no malote). */
  encaminhou_o_que_era_aguardar: number;
  divergencias: string[];
}

/** Pura: o placar de uma rodada. */
export function calcularPlacar(rs: readonly ResultadoCaso[]): Placar {
  const p: Placar = {
    casos: rs.length, status_esperado_ok: 0, status_esperado_total: 0, acerto_acao: 0, acerto_codigo: 0,
    com_gabarito_lancar: 0, sem_sugestao: 0, descartadas: 0, falhas: 0, proibidos_que_passaram: 0,
    encaminhou_o_que_era_aguardar: 0, divergencias: [],
  };
  for (const r of rs) {
    if (r.status === "sem_sugestao") p.sem_sugestao++;
    if (r.status === "descartada") p.descartadas++;
    if (r.status === "falha") p.falhas++;
    const c = r.sugestao?.codigo ?? null;
    if (c !== null && OCS_NUNCA_SUGERIR.has(c)) p.proibidos_que_passaram++;
    if (r.gabarito.acao === "aguardar" && r.sugestao?.acao === "encaminhar_relacionamento") p.encaminhou_o_que_era_aguardar++;
    if (r.esperado_status) {
      p.status_esperado_total++;
      if (r.esperado_status === r.status) p.status_esperado_ok++;
      else p.divergencias.push(`${r.id}: status ${r.status} (esperado ${r.esperado_status})`);
    }
    const acao = r.sugestao?.acao ?? "sem_sugestao";
    if (acao === r.gabarito.acao) p.acerto_acao++;
    if (r.gabarito.acao === "lancar_ocorrencia") {
      p.com_gabarito_lancar++;
      if (acao === "lancar_ocorrencia" && c === (r.gabarito.codigo ?? null)) p.acerto_codigo++;
    }
  }
  return p;
}

/** Pura: modo seco — a cerca de verdade sobre a resposta gravada. */
export function avaliarSeco(casos: readonly CasoEval[], dicionario = DICIONARIO_EVAL): ResultadoCaso[] {
  const permitidos = codigosPermitidosAgente(dicionario.keys());
  return casos.map((c) => {
    if (c.resposta_gravada === undefined) {
      return { id: c.id, status: "sem_resposta_gravada", sugestao: null, gabarito: c.gabarito, esperado_status: c.esperado_status };
    }
    const v = validarRespostaAgente(c.resposta_gravada, {
      permitidos, ocAtual: c.item.cod_ultima_ocorrencia, codigosLancaveisAtivos: new Set(), modelo: "gravado", versaoPrompt: AGENTE_OPERACAO_VERSION,
    });
    return { id: c.id, status: v.status, sugestao: v.sugestao, gabarito: c.gabarito, esperado_status: c.esperado_status };
  });
}

export function lerCasos(texto: string, jsonl: boolean): CasoEval[] {
  if (!jsonl) return JSON.parse(texto) as CasoEval[];
  return texto.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as CasoEval);
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((n / d) * 100)}% (${n}/${d})`;
}

export function relatorio(p: Placar, modo: string): string {
  return [
    `EVAL agente-operacao · prompt ${AGENTE_OPERACAO_VERSION} · modo ${modo} · ${p.casos} casos`,
    `  status esperado ......... ${pct(p.status_esperado_ok, p.status_esperado_total)}`,
    `  ação certa .............. ${pct(p.acerto_acao, p.casos)}`,
    `  código certo (lançar) ... ${pct(p.acerto_codigo, p.com_gabarito_lancar)}`,
    `  sem sugestão / descartadas / falhas: ${p.sem_sugestao} / ${p.descartadas} / ${p.falhas}`,
    `  PROIBIDOS QUE PASSARAM .. ${p.proibidos_que_passaram} (tem de ser 0)`,
    `  encaminhou o que era aguardar: ${p.encaminhou_o_que_era_aguardar}`,
    ...p.divergencias.map((d) => `  ✗ ${d}`),
  ].join("\n");
}

async function main() {
  const args = new Map<string, string>();
  for (let i = 0; i < Deno.args.length; i++) {
    const a = Deno.args[i]!;
    if (!a.startsWith("--")) continue;
    const prox = Deno.args[i + 1];
    if (prox && !prox.startsWith("--")) { args.set(a.slice(2), prox); i++; } else args.set(a.slice(2), "");
  }
  const arq = args.get("casos");
  const casos = arq
    ? lerCasos(await Deno.readTextFile(arq), arq.endsWith(".jsonl"))
    : lerCasos(await Deno.readTextFile(new URL("./agente-operacao/casos-sinteticos.json", import.meta.url)), false);
  const limite = Number(args.get("limit")) || casos.length;
  const amostra = casos.slice(0, limite);

  if (!args.has("ao-vivo")) {
    const p = calcularPlacar(avaliarSeco(amostra));
    console.log(relatorio(p, "seco (sem API)"));
    if (p.proibidos_que_passaram > 0 || p.status_esperado_ok !== p.status_esperado_total) Deno.exit(1);
    return;
  }

  const modelo = resolverModeloAgente(args.get("modelo"));
  const barrado = portaoDeCusto(modelo, amostra.length, args.get("confirmar-custo"));
  if (barrado) {
    console.error(barrado);
    Deno.exit(2);
  }
  const apiKey = lerChaveEvals(Deno.env); // INV-167: só a chave de evals
  const custo = new ContadorCusto(modelo);
  const resultados: ResultadoCaso[] = [];
  for (const c of amostra) {
    const r = await chamarAgenteOperacao({
      apiKey, modelo, codigosLancaveisAtivos: new Set(),
      entrada: montarEntradaAgente({ item: c.item, codigosOperacao: DICIONARIO_EVAL, historico: c.historico ?? [], agoraMs: Date.now() }),
    });
    custo.registrar({ input_tokens: r.tokens_entrada, output_tokens: r.tokens_saida });
    resultados.push({ id: c.id, status: r.status, sugestao: r.sugestao, gabarito: c.gabarito });
  }
  const p = calcularPlacar(resultados);
  console.log(relatorio(p, `ao vivo (${modelo})`));
  console.log(custo.relatorio());
  if (p.proibidos_que_passaram > 0) Deno.exit(1);
}

if (import.meta.main) await main();
