// =============================================================================
// operacao-agente-sugestao — CAMADA 2 da sugestão da Operação (ADR 0041 D10; INV-188).
//
// Só é chamado quando NENHUMA regra (fixa ou aprendida) casa. O agente de IA lê a
// situação do item e devolve UMA sugestão: um código da Operação, ou "encaminhar ao
// Relacionamento", ou nada. A saída passa por `validarRespostaAgente`, que DESCARTA:
//   - JSON inválido / fora do formato / cortado (sem reparo, sem 2ª tentativa);
//   - código proibido (49/54/59/33/44/6/9/16), 41/56 (texto da pessoa), 01 (entrega é
//     do motorista), código fora da lista de responsabilidade 'Operação', ou a própria oc;
//   - "aguardar" sem `reavaliar_em_horas` inteiro em 1..720;
//   - texto vazio ou acima de 70; confiança fora de 0..1.
// Descartado = sem sugestão. Falha (timeout, HTTP, rede) = sem sugestão. Nunca
// bloqueia a fila e nunca lança: aceitar continua sendo clique + prévia.
//
// UMA tentativa: usa `complete` (não `completeJson`, que repete e remenda JSON).
// Timeout por AbortController. O prompt é versionado em prompts/agente-operacao.md
// (espelho em _shared/prompts/agente-operacao.ts).
// =============================================================================

import { type AnthropicModel, type AnthropicUsageRecord, createAnthropicClient } from "./anthropic-client.ts";
import { OCS_PROIBIDAS_OPERACAO, OCS_TEXTO_OBRIGATORIO_OPERACAO, normalizarUnidade } from "./operacao-comum.ts";
import {
  type AcaoSugestao,
  CODIGO_ENTREGA,
  horasReavaliarValidas,
  OCS_NUNCA_SUGERIR,
  type RegraAprendidaOperacao,
  TEXTO_SUGESTAO_MAX,
  VERSAO_CONTRATO_SUGESTAO,
  type SugestaoOperacao,
} from "./operacao-sugestao.ts";
import {
  AGENTE_OPERACAO_MODEL,
  AGENTE_OPERACAO_SYSTEM_PROMPT,
  AGENTE_OPERACAO_VERSION,
} from "./prompts/agente-operacao.ts";

export const BASE_REGRA_AGENTE = "agente_ia" as const;
/** Teto de espera da chamada (a edge tem ~150 s para a rodada inteira). */
export const TIMEOUT_AGENTE_MS = 15_000;
export const MAX_TOKENS_AGENTE = 400;
export const JUSTIFICATIVA_MAX = 300;
export const INSTRUCAO_MAX = 500;
/** Env que troca o modelo (lista fechada abaixo). Vazio = AGENTE_OPERACAO_MODEL. */
export const ENV_MODELO_AGENTE = "OPERACAO_AGENTE_MODELO";
/**
 * Modelos aceitos pelo agente da Operação. O padrão é o Haiku 5.5 (decisão do dono, 07/10).
 * `anthropic-client.ts` (compartilhado, INV-055) não foi tocado: o tipo dele não lista o
 * Haiku 5.5, então o agente usa o tipo próprio abaixo e o cliente só repassa o id à API.
 */
export type ModeloAgenteOperacao = AnthropicModel | "claude-haiku-5-5";
export const MODELOS_PERMITIDOS_AGENTE: readonly ModeloAgenteOperacao[] = [
  "claude-haiku-5-5", "claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7",
];

/** Pura: o modelo do agente. Valor fora da lista → o padrão (nunca um modelo arbitrário). */
export function resolverModeloAgente(valorEnv: string | null | undefined): ModeloAgenteOperacao {
  const v = (valorEnv ?? "").trim() as ModeloAgenteOperacao;
  return MODELOS_PERMITIDOS_AGENTE.includes(v) ? v : AGENTE_OPERACAO_MODEL;
}

/** Pura: os códigos que o agente pode sugerir = responsabilidade 'Operação' − proibidos − 41/56 − 01. */
export function codigosPermitidosAgente(codigosOperacao: Iterable<number>): Set<number> {
  const s = new Set<number>();
  for (const c of codigosOperacao) if (Number.isInteger(c) && !OCS_NUNCA_SUGERIR.has(c)) s.add(c);
  return s;
}

export interface ItemAgente {
  op_item_id: string;
  cod_ultima_ocorrencia: number | null;
  data_ultima_ocorrencia: string | null;
  instrucao_ultima_ocorrencia: string | null;
  unidade: string | null;
  cidade_destino: string | null;
  uf_destino: string | null;
  pagador: string | null;
  /** Só para casar regra aprendida por pagador; NUNCA vai para o agente. */
  cnpj_pagador?: string | null;
}

export interface EntradaAgenteOperacao {
  oc_atual: number | null;
  descricao_oc_atual: string | null;
  instrucao_ultima_oc: string | null;
  dias_parado: number | null;
  unidade: string | null;
  cidade: string | null;
  uf: string | null;
  pagador: string | null;
  historico_do_estado: Array<{
    acao: AcaoSugestao; codigo: number | null; texto: string; confianca: number; casos: number; instrucao_padrao: string | null;
  }>;
  codigos_operacao: Array<{ codigo: number; descricao: string }>;
}

/** Pura: a entrada do agente (sem CTRC, NF nem CNPJ: o agente não precisa e não deve ver). */
export function montarEntradaAgente(args: {
  item: ItemAgente;
  /** código → descrição dos códigos de responsabilidade 'Operação' (dicionário). */
  codigosOperacao: ReadonlyMap<number, string>;
  /** descrição da oc atual (qualquer responsabilidade). */
  descricaoOcAtual?: string | null;
  historico: readonly RegraAprendidaOperacao[];
  agoraMs: number;
}): EntradaAgenteOperacao {
  const i = args.item;
  const t = i.data_ultima_ocorrencia ? Date.parse(i.data_ultima_ocorrencia) : NaN;
  const permitidos = codigosPermitidosAgente(args.codigosOperacao.keys());
  return {
    oc_atual: i.cod_ultima_ocorrencia,
    descricao_oc_atual: args.descricaoOcAtual ?? (i.cod_ultima_ocorrencia !== null ? args.codigosOperacao.get(i.cod_ultima_ocorrencia) ?? null : null),
    instrucao_ultima_oc: i.instrucao_ultima_ocorrencia ? i.instrucao_ultima_ocorrencia.slice(0, INSTRUCAO_MAX) : null,
    dias_parado: Number.isFinite(t) ? Math.max(0, Math.floor((args.agoraMs - t) / 86_400_000)) : null,
    unidade: normalizarUnidade(i.unidade),
    cidade: i.cidade_destino,
    uf: i.uf_destino,
    pagador: i.pagador,
    historico_do_estado: args.historico.slice(0, 3).map((r) => ({
      acao: r.acao, codigo: r.codigo, texto: r.texto, confianca: r.confianca, casos: r.casos,
      instrucao_padrao: r.estado.instrucao_padrao ?? null,
    })),
    codigos_operacao: [...permitidos].sort((a, b) => a - b).map((c) => ({ codigo: c, descricao: args.codigosOperacao.get(c) ?? "" })),
  };
}

export type StatusAgente = "ok" | "sem_sugestao" | "descartada" | "falha";

export interface ResultadoAgente {
  status: StatusAgente;
  sugestao: SugestaoOperacao | null;
  /** Por que não há sugestão (descartada/falha/sem_sugestao). */
  motivo: string | null;
  modelo: string;
  versao_prompt: string;
  tokens_entrada: number;
  tokens_saida: number;
  duracao_ms: number;
}

/** Pura: valida a resposta do modelo. Qualquer desvio → sem sugestão, com o motivo. */
export function validarRespostaAgente(texto: string, ctx: {
  permitidos: ReadonlySet<number>;
  ocAtual: number | null;
  codigosLancaveisAtivos: ReadonlySet<number>;
  modelo: string;
  versaoPrompt: string;
  /** Para calcular `reavaliar_em` de "aguardar" (padrão: agora). */
  agoraMs?: number;
}): { status: Exclude<StatusAgente, "falha">; sugestao: SugestaoOperacao | null; motivo: string | null } {
  const nada = (status: "sem_sugestao" | "descartada", motivo: string) => ({ status, sugestao: null, motivo });
  let t = (texto ?? "").trim();
  const cerca = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (cerca) t = cerca[1]!.trim();
  let o: unknown;
  try {
    o = JSON.parse(t);
  } catch {
    return nada("descartada", "json_invalido");
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return nada("descartada", "json_nao_e_objeto");
  const r = o as Record<string, unknown>;
  const acao = r.acao;
  if (acao === "sem_sugestao") return nada("sem_sugestao", "o agente não viu base para sugerir");
  if (acao !== "lancar_ocorrencia" && acao !== "encaminhar_relacionamento" && acao !== "aguardar") {
    return nada("descartada", "acao_desconhecida");
  }

  let codigo: number | null = null;
  if (acao === "lancar_ocorrencia") {
    if (typeof r.codigo !== "number" || !Number.isInteger(r.codigo)) return nada("descartada", "codigo_ausente");
    codigo = r.codigo;
    if (OCS_PROIBIDAS_OPERACAO.has(codigo)) return nada("descartada", `codigo_proibido:${codigo}`);
    if (OCS_TEXTO_OBRIGATORIO_OPERACAO.has(codigo)) return nada("descartada", `codigo_texto_da_pessoa:${codigo}`);
    if (codigo === CODIGO_ENTREGA) return nada("descartada", "codigo_entrega_e_do_motorista:1");
    if (!ctx.permitidos.has(codigo)) return nada("descartada", `codigo_fora_da_operacao:${codigo}`);
    if (ctx.ocAtual !== null && codigo === ctx.ocAtual) return nada("descartada", "repete_oc_atual");
  } else if (r.codigo !== null && r.codigo !== undefined) {
    return nada("descartada", acao === "aguardar" ? "aguardar_com_codigo" : "encaminhar_com_codigo");
  }
  let horas: number | null = null;
  if (acao === "aguardar") {
    horas = horasReavaliarValidas(r.reavaliar_em_horas);
    if (horas === null) return nada("descartada", "reavaliar_invalido");
  }

  const txt = typeof r.texto === "string" ? r.texto.trim() : "";
  if (txt.length < 3) return nada("descartada", "texto_vazio");
  if (txt.length > TEXTO_SUGESTAO_MAX) return nada("descartada", "texto_longo");
  const conf = r.confianca;
  if (typeof conf !== "number" || !(conf >= 0 && conf <= 1)) return nada("descartada", "confianca_invalida");
  const just = typeof r.justificativa === "string" ? r.justificativa.trim().slice(0, JUSTIFICATIVA_MAX) : "";

  return {
    status: "ok",
    motivo: null,
    sugestao: {
      versao_contrato: VERSAO_CONTRATO_SUGESTAO,
      acao,
      fonte: "agente_ia",
      base_regra: BASE_REGRA_AGENTE,
      regra_id: BASE_REGRA_AGENTE,
      codigo,
      texto: txt,
      motivo: just || "sugestão do agente de IA",
      lancavel: codigo !== null && ctx.codigosLancaveisAtivos.has(codigo),
      confianca: conf,
      casos: null,
      oc_base: ctx.ocAtual,
      versao_regras: `agente:${ctx.versaoPrompt}`,
      modelo: ctx.modelo,
      versao_prompt: ctx.versaoPrompt,
      justificativa: just || null,
      ...(horas !== null
        ? { reavaliar_em_horas: horas, reavaliar_em: new Date((ctx.agoraMs ?? Date.now()) + horas * 3_600_000).toISOString() }
        : {}),
    },
  };
}

/**
 * Chama o agente UMA vez, com timeout. Nunca lança: qualquer erro vira
 * `{status:"falha"}`. `fetch` injetável (teste com fetch falso, sem rede).
 */
export async function chamarAgenteOperacao(args: {
  apiKey: string;
  entrada: EntradaAgenteOperacao;
  codigosLancaveisAtivos: ReadonlySet<number>;
  modelo?: ModeloAgenteOperacao;
  timeoutMs?: number;
  fetch?: typeof fetch;
  onUsage?: (rec: AnthropicUsageRecord) => void | Promise<void>;
  opItemId?: string;
  agora?: () => number;
}): Promise<ResultadoAgente> {
  const agora = args.agora ?? Date.now;
  const modelo = args.modelo ?? AGENTE_OPERACAO_MODEL;
  const inicio = agora();
  const base = { modelo, versao_prompt: AGENTE_OPERACAO_VERSION, tokens_entrada: 0, tokens_saida: 0 };
  const ctrl = new AbortController();
  const timeoutMs = args.timeoutMs ?? TIMEOUT_AGENTE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const f = args.fetch ?? fetch;
  const fetchComPrazo: typeof fetch = (input, init) => f(input, { ...(init ?? {}), signal: ctrl.signal });
  const prazo = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      ctrl.abort();
      rej(new Error("timeout"));
    }, timeoutMs);
  });
  try {
    const client = createAnthropicClient({ env: { apiKey: args.apiKey }, fetch: fetchComPrazo, onUsage: args.onUsage });
    const res = await Promise.race([
      client.complete({
        model: modelo as AnthropicModel, // o cliente repassa o id; ver ModeloAgenteOperacao
        system: AGENTE_OPERACAO_SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(args.entrada) }],
        maxTokens: MAX_TOKENS_AGENTE,
        temperature: 0,
        meta: { functionName: "sugerir-operacao", agentName: "agente-operacao", cardId: args.opItemId },
      }),
      prazo,
    ]);
    const uso = { ...base, modelo: res.model || modelo, tokens_entrada: res.inputTokens, tokens_saida: res.outputTokens };
    if (res.stopReason === "max_tokens") {
      return { ...uso, status: "falha", sugestao: null, motivo: "resposta_cortada", duracao_ms: agora() - inicio };
    }
    const v = validarRespostaAgente(res.text, {
      permitidos: new Set(args.entrada.codigos_operacao.map((c) => c.codigo)),
      ocAtual: args.entrada.oc_atual,
      codigosLancaveisAtivos: args.codigosLancaveisAtivos,
      modelo: uso.modelo,
      versaoPrompt: AGENTE_OPERACAO_VERSION,
      agoraMs: agora(),
    });
    return { ...uso, ...v, duracao_ms: agora() - inicio };
  } catch (e) {
    const msg = ctrl.signal.aborted ? "timeout" : (e instanceof Error ? e.message : String(e)).slice(0, 200);
    return { ...base, status: "falha", sugestao: null, motivo: msg, duracao_ms: agora() - inicio };
  } finally {
    clearTimeout(timer);
  }
}
