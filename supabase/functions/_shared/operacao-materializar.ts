// =============================================================================
// operacao-materializar — a fila da Operação nasce do Bastão (ADR 0041, D4).
//
// Roda na edge `materializar-fila-operacao` (cron, mig 432). Esta parte é PURA:
// recebe as pendências do Bastão que são da Operação, os CTRCs com card ATIVO do
// Relacionamento, os itens abertos da fila e as regras, e devolve o PLANO
// (criar/atualizar, encerrar, confirmar lançamento). Quem grava é a RPC
// `op_materializar_aplicar`, numa transação.
//
// Regras (cada uma travada em teste):
//   - "da Operação" segue a mesma hierarquia do `state_pelo_bastao` (mig 029):
//     `responsavel_atual` do Bastão manda; vazio → dicionário (responsabilidade
//     'Operação');
//   - NUNCA entra: finalizadoras 1/30/32, documentais 2/34, e CTRC com card
//     ATIVO no Relacionamento ("Relacionamento não aparece para a Operação, nem
//     vice-versa": a nota com tratativa aberta simplesmente não entra);
//   - unidade pela `op_regra_unidade_por_oc` (vazia = sem unidade → só o
//     supervisor e o gestor veem o item);
//   - guard anti-loop INV-040: com LIMITE_TERMINAIS_24H ou mais itens ENCERRADOS
//     do mesmo CTRC criados em 24 h, o item não renasce (mesma decisão pura do
//     sync, importada de guard-anti-loop-criacao.ts);
//   - fechamento em massa suspeito (Bastão vazio ou mais da metade da fila
//     sumindo de uma vez) NÃO encerra nada: espera a próxima leitura;
//   - a confirmação de um lançamento vem daqui: o Bastão mostra a oc lançada.
// =============================================================================

import { excedeuLimiteLoopCriacao, LIMITE_TERMINAIS_24H } from "./guard-anti-loop-criacao.ts";
import {
  FLAG_OPERACAO_FILA,
  normalizarCtrcOp,
  normalizarNfOp,
  normalizarUnidade,
  OCS_DOCUMENTAIS_OPERACAO,
  OCS_FINALIZADORAS_OPERACAO,
} from "./operacao-comum.ts";
import {
  type RegraAprendidaOperacao,
  type RegraSugestaoOperacao,
  sugerirPorRegras,
  type SugestaoOperacao,
} from "./operacao-sugestao.ts";

/** O limite do guard anti-loop INV-040, importado (não copiado). */
export const LIMITE_ENCERRADOS_24H_OPERACAO = LIMITE_TERMINAIS_24H;
/** Acima disto de itens abertos, sumir mais da metade numa leitura é suspeito. */
export const FECHAMENTO_EM_MASSA_MIN_ITENS = 20;

/** Campos do Bastão que podem dar a unidade (CHECK de op_regra_unidade_por_oc). */
export const CAMPOS_UNIDADE = ["unidade_atual", "unidade_destino", "base_destino", "unidade_origem", "filial"] as const;
export type CampoUnidade = typeof CAMPOS_UNIDADE[number];

export interface PendenciaOperacao {
  id: string;
  ctrc: string | null;
  nf: string | null;
  filial: string | null;
  cod_ultima_ocorrencia: number | null;
  instrucao_ultima_ocorrencia: string | null;
  data_ultima_ocorrencia: string | null;
  responsavel_atual: string | null;
  pagador: string | null;
  cnpj_pagador: string | null;
  destinatario: string | null;
  cidade_destino: string | null;
  uf_destino: string | null;
  base_destino: string | null;
  unidade_origem: string | null;
  unidade_destino: string | null;
  unidade_atual: string | null;
  previsao_entrega: string | null;
  atraso_original: number | null;
  qtd_volumes: number | null;
  /** Tipo do CT-e no Bastão (NORMAL, DEVOLUCAO, REDESPACHO, REVERSA, SUBC FORM CTRC…). Filtro da tela (Caio 08/10). */
  tipo_documento?: string | null;
}

export interface RegraUnidade {
  codigo_oc: number | null;
  campo_bastao: CampoUnidade;
  prioridade: number;
  ativo: boolean;
}

export interface LancamentoAtivoResumo {
  id: string;
  codigo_oc: number;
  status: "fila" | "lancando" | "lancado";
}

export interface ItemAberto {
  id: string;
  ctrc: string;
  snapshot_hash: string | null;
  lancamento_ativo: LancamentoAtivoResumo | null;
  /** oc e sugestão gravadas no item (para preservar a sugestão do agente; INV-188). */
  cod_ultima_ocorrencia?: number | null;
  sugestao?: SugestaoOperacao | null;
}

export interface UpsertItem {
  ctrc: string;
  nf: string | null;
  unidade: string | null;
  bastao_pendencia_id: string;
  cod_ultima_ocorrencia: number | null;
  instrucao_ultima_ocorrencia: string | null;
  data_ultima_ocorrencia: string | null;
  responsavel_atual: string | null;
  pagador: string | null;
  cnpj_pagador: string | null;
  destinatario: string | null;
  cidade_destino: string | null;
  uf_destino: string | null;
  previsao_entrega: string | null;
  atraso_original: number | null;
  qtd_volumes: number | null;
  /** = Bastão.tipo_documento, normalizado (maiúsculas, sem espaço nas pontas). */
  tipo_cte: string | null;
  sugestao: SugestaoOperacao | null;
  snapshot_hash: string;
  novo: boolean;
}

export type MotivoEncerramento =
  | "saiu_da_operacao"
  | "card_relacionamento_ativo"
  | "nota_finalizada"
  | "oc_documental"
  | "encaminhado_relacionamento"
  | "encaminhado_espelho";

export interface PlanoMaterializacao {
  upserts: UpsertItem[];
  encerrar: Array<{ op_item_id: string; ctrc: string; motivo: MotivoEncerramento }>;
  confirmar: Array<{ lancamento_id: string; oc_vista: number }>;
  bloqueados_loop: string[];
  /** Fechamento em massa suspeito: nada foi encerrado por "saiu da operação". */
  fechamento_retido: string | null;
  ignorados: Record<string, number>;
}

// ── setores (mig 441, ADR 0042) ──────────────────────────────────────────────
// Fonte: o Pendências (tatiana-kelly/pendency-tracker@a884368, src/types/pendencia.ts:63-86).
// O espelho SQL é public.op_setor_do_item (mig 441); o teste operacao-setores.test.ts
// trava a semente da migration contra apps/cockpit-web/src/lib/operacao/setores.ts.

export const SETORES_CONHECIDOS = [
  "OPERACAO", "AGENDAMENTO", "DEVOLUCAO", "RESSARCIMENTO", "PERDAS", "CLIENTE", "RELACIONAMENTO",
] as const;
export type SetorConhecido = typeof SETORES_CONHECIDOS[number];
export type SetorOuNaoIdentificado = SetorConhecido | "NAO_IDENTIFICADO";
/** O Relacionamento NUNCA entra na fila da Operação (ADR 0041 D2) — nem que a config diga. */
export const SETOR_NUNCA_NA_FILA = "RELACIONAMENTO";

/** Um setor ligado na fila e os códigos dele (RPC op_setores_na_fila, mig 441). */
export interface SetorNaFila {
  setor: string;
  codigos: readonly number[];
}

function normalizarResponsavel(r: string | null | undefined): string {
  return (r ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function ehSetorConhecido(s: string): s is SetorConhecido {
  return (SETORES_CONHECIDOS as readonly string[]).includes(s);
}

/**
 * Pura: o setor dono da pendência. Mesma hierarquia do op_setor_do_item (SQL):
 * responsavel_atual que é um setor conhecido manda; senão (vazio OU desconhecido) o
 * mapa pela oc; senão NAO_IDENTIFICADO.
 */
export function setorDaPendencia(
  p: Pick<PendenciaOperacao, "responsavel_atual" | "cod_ultima_ocorrencia">,
  mapaOcSetor: ReadonlyMap<number, string>,
): SetorOuNaoIdentificado {
  const resp = normalizarResponsavel(p.responsavel_atual).toUpperCase();
  // Responsável preenchido manda, mesmo desconhecido (ex.: "indenizacao", mig 029): fica
  // NAO_IDENTIFICADO e não entra — a mesma exclusão do ehDaOperacao antigo (revisão 08/10).
  if (resp) return ehSetorConhecido(resp) ? resp : "NAO_IDENTIFICADO";
  const oc = p.cod_ultima_ocorrencia;
  const doMapa = oc === null ? undefined : mapaOcSetor.get(oc);
  return doMapa && ehSetorConhecido(doMapa) ? doMapa : "NAO_IDENTIFICADO";
}

/**
 * Pura: a config de setores, saneada. Setor desconhecido e RELACIONAMENTO saem;
 * código inválido sai; setor repetido junta os códigos. Vazio = use o padrão.
 */
export function sanearSetoresNaFila(setores: readonly SetorNaFila[] | null | undefined): SetorNaFila[] {
  const porSetor = new Map<string, Set<number>>();
  for (const s of setores ?? []) {
    const id = String(s?.setor ?? "").trim().toUpperCase();
    if (!ehSetorConhecido(id) || id === SETOR_NUNCA_NA_FILA) continue;
    const cods = porSetor.get(id) ?? new Set<number>();
    for (const c of s.codigos ?? []) {
      const n = Number(c);
      if (Number.isInteger(n) && n > 0) cods.add(n);
    }
    porSetor.set(id, cods);
  }
  return [...porSetor].map(([setor, cods]) => ({ setor, codigos: [...cods].sort((a, b) => a - b) }));
}

/** Pura: oc → setor a partir dos setores ligados (o primeiro que declara a oc vence). */
export function mapaOcSetorDe(codigosDosSetores: ReadonlyMap<string, Iterable<number>>): Map<number, string> {
  const m = new Map<number, string>();
  for (const [setor, cods] of codigosDosSetores) {
    for (const c of cods) if (!m.has(c)) m.set(c, setor);
  }
  return m;
}

/**
 * Pura: a pendência é de um setor que está na fila? RELACIONAMENTO nunca (mesmo que
 * apareça em `setoresNaFila`).
 */
export function ehDosSetoresDaFila(
  p: Pick<PendenciaOperacao, "responsavel_atual" | "cod_ultima_ocorrencia">,
  setoresNaFila: Iterable<string>,
  codigosDosSetores: ReadonlyMap<string, Iterable<number>>,
): boolean {
  const fila = new Set([...setoresNaFila].map((s) => s.toUpperCase()));
  fila.delete(SETOR_NUNCA_NA_FILA);
  const setor = setorDaPendencia(p, mapaOcSetorDe(codigosDosSetores));
  return setor !== SETOR_NUNCA_NA_FILA && setor !== "NAO_IDENTIFICADO" && fila.has(setor);
}

/**
 * Pura: a pendência é da Operação? (o padrão de antes da 441: só o setor OPERACAO,
 * com os códigos do dicionário). Mesma hierarquia do state_pelo_bastao (mig 029).
 */
export function ehDaOperacao(p: Pick<PendenciaOperacao, "responsavel_atual" | "cod_ultima_ocorrencia">, codigosOperacao: ReadonlySet<number>): boolean {
  return ehDosSetoresDaFila(p, ["OPERACAO"], new Map([["OPERACAO", codigosOperacao]]));
}

/** Pura: unidade do item pela regra. Regra específica da oc vence a genérica; depois a prioridade. */
export function resolverUnidade(p: PendenciaOperacao, regras: readonly RegraUnidade[]): string | null {
  const oc = p.cod_ultima_ocorrencia;
  const candidatas = regras
    .filter((r) => r.ativo && (r.codigo_oc === null || r.codigo_oc === oc) && CAMPOS_UNIDADE.includes(r.campo_bastao))
    .sort((a, b) => {
      const espA = a.codigo_oc === null ? 1 : 0;
      const espB = b.codigo_oc === null ? 1 : 0;
      return espA - espB || a.prioridade - b.prioridade;
    });
  for (const r of candidatas) {
    const u = normalizarUnidade(p[r.campo_bastao]);
    if (u) return u;
  }
  return null;
}

/** Pura: o tipo do CT-e como a tela filtra — maiúsculas, sem espaço nas pontas; vazio → null. */
export function normalizarTipoCte(t: string | null | undefined): string | null {
  const v = (t ?? "").trim().toUpperCase();
  return v ? v : null;
}

/**
 * Pura e estável: muda quando algo que a tela mostra muda. A sugestão do AGENTE
 * fica de fora: ela é gravada por outra edge (sugerir-operacao) e não pode, sozinha,
 * fazer o materializador reescrever o item a cada rodada.
 */
export function hashSnapshot(u: Omit<UpsertItem, "snapshot_hash" | "novo">): string {
  const s = u.sugestao && u.sugestao.fonte !== "agente_ia" ? u.sugestao : null;
  return JSON.stringify([
    u.nf, u.unidade, u.cod_ultima_ocorrencia, u.instrucao_ultima_ocorrencia, u.data_ultima_ocorrencia,
    u.responsavel_atual, u.pagador, u.destinatario, u.cidade_destino, u.uf_destino, u.previsao_entrega,
    u.atraso_original, u.qtd_volumes, u.tipo_cte, s ? [s.regra_id, s.acao ?? "lancar_ocorrencia", s.codigo, s.lancavel] : null,
  ]);
}

/**
 * Pura: nenhuma regra casou — a sugestão do agente que já está no item continua
 * valendo enquanto a oc for a MESMA em que ela foi feita (cache por item + oc). oc
 * mudou → null: a edge sugerir-operacao reavalia (INV-188).
 */
export function preservarSugestaoDoAgente(
  existente: SugestaoOperacao | null | undefined,
  ocAtual: number | null,
  codigosLancaveisAtivos: ReadonlySet<number>,
): SugestaoOperacao | null {
  if (!existente || existente.fonte !== "agente_ia") return null;
  if (ocAtual === null || existente.oc_base !== ocAtual) return null;
  const lancavel = existente.acao === "lancar_ocorrencia" && existente.codigo !== null && codigosLancaveisAtivos.has(existente.codigo);
  return lancavel === existente.lancavel ? existente : { ...existente, lancavel };
}

function conta(m: Record<string, number>, k: string): void {
  m[k] = (m[k] ?? 0) + 1;
}

export function planejarMaterializacao(args: {
  pendencias: readonly PendenciaOperacao[];
  /** Códigos com responsabilidade 'Operação' no ocorrencias_dicionario. */
  codigosOperacao: ReadonlySet<number>;
  /**
   * Setores ligados na fila (mig 441). Ausente/vazio = o padrão de antes: só OPERACAO
   * com `codigosOperacao` (ehDaOperacao). RELACIONAMENTO é descartado.
   */
  setoresNaFila?: readonly SetorNaFila[];
  /** Motivo para NÃO encerrar nada por "saiu" nesta rodada (ex.: a config de setores falhou). */
  reterFechamento?: string | null;
  /** CTRCs (normalizados) com card ATIVO no Relacionamento. */
  ctrcsComCardAtivo: ReadonlySet<string>;
  itensAbertos: readonly ItemAberto[];
  /** CTRC → nº de itens ENCERRADOS criados nas últimas 24 h (guard INV-040). */
  encerradosPorCtrc24h: ReadonlyMap<string, number>;
  regrasUnidade: readonly RegraUnidade[];
  codigosLancaveisAtivos: ReadonlySet<number>;
  regrasSugestao?: readonly RegraSugestaoOperacao[];
  /** Camada 1 (op_regras_sugestao, mig 434). */
  regrasAprendidas?: readonly RegraAprendidaOperacao[];
  /** CTRCs encaminhados ao Relacionamento cujo pedido ainda não terminou: não renascem na fila. */
  ctrcsEncaminhamentoPendente?: ReadonlySet<string>;
  /** Modo espelho (ADR 0041 D12): CTRC → oc em que foi ao espelho. Na MESMA oc não renasce. */
  espelhoOcPorCtrc?: ReadonlyMap<string, number | null>;
  agoraMs: number;
  /** false quando a leitura do Bastão parou no meio: nada encerra por "sumiu". */
  leituraCompleta?: boolean;
}): PlanoMaterializacao {
  const plano: PlanoMaterializacao = {
    upserts: [], encerrar: [], confirmar: [], bloqueados_loop: [], fechamento_retido: null, ignorados: {},
  };
  const abertosPorCtrc = new Map(args.itensAbertos.map((i) => [i.ctrc, i]));
  const vistosNaOperacao = new Set<string>();
  const setores = sanearSetoresNaFila(args.setoresNaFila);
  const ehDaFila: (p: PendenciaOperacao) => boolean = setores.length === 0
    ? (p) => ehDaOperacao(p, args.codigosOperacao)
    : (() => {
      const nomes = setores.map((s) => s.setor);
      const cods = new Map(setores.map((s) => [s.setor, s.codigos] as const));
      return (p: PendenciaOperacao) => ehDosSetoresDaFila(p, nomes, cods);
    })();

  for (const p of args.pendencias) {
    const ctrc = normalizarCtrcOp(p.ctrc);
    if (!ctrc) { conta(plano.ignorados, "sem_ctrc"); continue; }
    if (vistosNaOperacao.has(ctrc)) { conta(plano.ignorados, "ctrc_repetido_no_bastao"); continue; }
    if (!ehDaFila(p)) { conta(plano.ignorados, "nao_e_da_operacao"); continue; }
    vistosNaOperacao.add(ctrc);
    const aberto = abertosPorCtrc.get(ctrc) ?? null;
    const oc = p.cod_ultima_ocorrencia;

    // Confirmação pela leitura seguinte: o Bastão já mostra a oc lançada.
    if (aberto?.lancamento_ativo?.status === "lancado" && oc !== null && oc === aberto.lancamento_ativo.codigo_oc) {
      plano.confirmar.push({ lancamento_id: aberto.lancamento_ativo.id, oc_vista: oc });
    }

    let motivoFora: MotivoEncerramento | null = null;
    if (oc !== null && OCS_FINALIZADORAS_OPERACAO.has(oc)) motivoFora = "nota_finalizada";
    else if (oc !== null && OCS_DOCUMENTAIS_OPERACAO.has(oc)) motivoFora = "oc_documental";
    else if (args.ctrcsComCardAtivo.has(ctrc)) motivoFora = "card_relacionamento_ativo";
    else if (args.ctrcsEncaminhamentoPendente?.has(ctrc)) motivoFora = "encaminhado_relacionamento";
    else if (args.espelhoOcPorCtrc?.has(ctrc) && args.espelhoOcPorCtrc.get(ctrc) === oc) motivoFora = "encaminhado_espelho";
    if (motivoFora) {
      conta(plano.ignorados, motivoFora);
      if (aberto) plano.encerrar.push({ op_item_id: aberto.id, ctrc, motivo: motivoFora });
      continue;
    }

    if (!aberto && excedeuLimiteLoopCriacao(args.encerradosPorCtrc24h.get(ctrc) ?? 0)) {
      plano.bloqueados_loop.push(ctrc);
      continue;
    }

    const unidade = resolverUnidade(p, args.regrasUnidade);
    const sugestaoRegra = sugerirPorRegras({
      item: {
        cod_ultima_ocorrencia: oc, data_ultima_ocorrencia: p.data_ultima_ocorrencia, unidade,
        instrucao_ultima_ocorrencia: p.instrucao_ultima_ocorrencia, cnpj_pagador: p.cnpj_pagador,
        previsao_entrega: p.previsao_entrega,
        // ocorrencias_anteriores: sem fonte no Bastão hoje → regra com essa condição não casa (ADR 0041 D10).
      },
      regrasFixas: args.regrasSugestao,
      regrasAprendidas: args.regrasAprendidas,
      codigosLancaveisAtivos: args.codigosLancaveisAtivos,
      agoraMs: args.agoraMs,
    });
    const base: Omit<UpsertItem, "snapshot_hash" | "novo"> = {
      ctrc,
      nf: normalizarNfOp(p.nf),
      unidade,
      bastao_pendencia_id: p.id,
      cod_ultima_ocorrencia: oc,
      instrucao_ultima_ocorrencia: p.instrucao_ultima_ocorrencia,
      data_ultima_ocorrencia: p.data_ultima_ocorrencia,
      responsavel_atual: p.responsavel_atual,
      pagador: p.pagador,
      cnpj_pagador: p.cnpj_pagador,
      destinatario: p.destinatario,
      cidade_destino: p.cidade_destino,
      uf_destino: p.uf_destino,
      previsao_entrega: p.previsao_entrega,
      atraso_original: p.atraso_original,
      qtd_volumes: p.qtd_volumes,
      tipo_cte: normalizarTipoCte(p.tipo_documento),
      sugestao: sugestaoRegra,
    };
    const hash = hashSnapshot(base);
    if (aberto && aberto.snapshot_hash === hash) { conta(plano.ignorados, "sem_mudanca"); continue; }
    // Regra casou → ela manda. Senão, a do agente segue se a oc é a mesma.
    const sugestao = sugestaoRegra ?? preservarSugestaoDoAgente(aberto?.sugestao, oc, args.codigosLancaveisAtivos);
    plano.upserts.push({ ...base, sugestao, snapshot_hash: hash, novo: !aberto });
  }

  // Itens abertos que não estão mais na lista da Operação.
  const sumiram = args.itensAbertos.filter((i) =>
    !vistosNaOperacao.has(i.ctrc) && !plano.encerrar.some((e) => e.op_item_id === i.id)
  );
  const n = args.itensAbertos.length;
  if (sumiram.length > 0) {
    if (args.leituraCompleta === false) {
      plano.fechamento_retido = `leitura do Bastão incompleta; ${sumiram.length} item(ns) fora da lista não foram encerrados`;
    } else if (args.reterFechamento) {
      plano.fechamento_retido = `${args.reterFechamento}; ${sumiram.length} item(ns) fora da lista não foram encerrados`;
    } else if (args.pendencias.length === 0) {
      plano.fechamento_retido = `o Bastão devolveu 0 pendências da Operação com ${n} itens abertos; nada encerrado`;
    } else if (n >= FECHAMENTO_EM_MASSA_MIN_ITENS && sumiram.length * 2 > n) {
      plano.fechamento_retido = `${sumiram.length} de ${n} itens sumiriam numa leitura só; nada encerrado`;
    } else {
      for (const i of sumiram) plano.encerrar.push({ op_item_id: i.id, ctrc: i.ctrc, motivo: "saiu_da_operacao" });
    }
  }
  return plano;
}

// ── orquestração (I/O injetado → deno test) ──────────────────────────────────

export interface RepoMaterializacao {
  flagLigada(key: string): Promise<boolean>;
  /** Códigos com responsabilidade 'Operação' no ocorrencias_dicionario. */
  codigosOperacao(): Promise<number[]>;
  /**
   * Setores ligados na fila e seus códigos (RPC op_setores_na_fila, mig 441). Ausente,
   * vazio ou com erro = o padrão de antes (só OPERACAO pelo dicionário). Erro também
   * RETÉM o fechamento da rodada: sem saber os setores, nada é encerrado por "saiu".
   */
  setoresNaFila?(): Promise<SetorNaFila[]>;
  /** CTRCs (normalizados) com card ATIVO. Lança em erro → a rodada para (fail-closed). */
  ctrcsComCardAtivo(): Promise<Set<string>>;
  itensAbertos(): Promise<ItemAberto[]>;
  encerradosPorCtrc24h(): Promise<Map<string, number>>;
  regrasUnidade(): Promise<RegraUnidade[]>;
  codigosLancaveisAtivos(): Promise<Set<number>>;
  /** Camada 1: op_regras_sugestao ativas (mig 434). Ausente/erro = sem regra aprendida (nunca para a rodada). */
  regrasAprendidas?(): Promise<RegraAprendidaOperacao[]>;
  /** CTRCs com encaminhamento ao Relacionamento ainda em curso (mig 436). Lança em erro → a rodada para. */
  ctrcsEncaminhamentoPendente?(): Promise<Set<string>>;
  /** CTRC → oc em que foi ao espelho do Relacionamento (mig 438). */
  ctrcsNoEspelho?(): Promise<Map<string, number | null>>;
  /** RPC op_materializar_aplicar (uma transação por lote). */
  aplicar(lote: { upserts: UpsertItem[]; encerrar: PlanoMaterializacao["encerrar"]; confirmar: PlanoMaterializacao["confirmar"]; bloqueados: string[] }): Promise<Record<string, number>>;
  registrarRodada(r: { iniciadoEm: string; ok: boolean; resumo: Record<string, unknown> }): Promise<void>;
}

export interface FonteBastaoOperacao {
  /**
   * `codigosOperacao` = códigos (de todos os setores ligados) que entram com responsável
   * vazio; `setores` = responsáveis aceitos em minúsculas (ausente = ["operacao"]).
   */
  fetchPendenciasDaOperacao(opts: { codigosOperacao: readonly number[]; setores?: readonly string[] }): Promise<{
    pendencias: PendenciaOperacao[];
    completo: boolean;
    erro: string | null;
  }>;
}

export const LOTE_APLICAR = 200;

export interface ResumoMaterializacao {
  skipped: string | null;
  ok: boolean;
  pendencias_bastao: number;
  leitura_completa: boolean;
  upserts: number;
  encerrar: number;
  confirmar: number;
  bloqueados_loop: number;
  fechamento_retido: string | null;
  ignorados: Record<string, number>;
  aplicado: Record<string, number>;
  erros: string[];
  /** Setores que esta rodada trouxe (mig 441); só presente quando o repo sabe ler os setores. */
  setores_na_fila?: string[];
}

export async function rodarMaterializacao(deps: {
  repo: RepoMaterializacao;
  bastao: FonteBastaoOperacao;
  regrasSugestao?: readonly RegraSugestaoOperacao[];
  agora?: () => Date;
}): Promise<ResumoMaterializacao> {
  const agora = deps.agora ?? (() => new Date());
  const iniciadoEm = agora().toISOString();
  const r: ResumoMaterializacao = {
    skipped: null, ok: false, pendencias_bastao: 0, leitura_completa: false, upserts: 0, encerrar: 0, confirmar: 0,
    bloqueados_loop: 0, fechamento_retido: null, ignorados: {}, aplicado: {}, erros: [],
  };
  if (!(await deps.repo.flagLigada(FLAG_OPERACAO_FILA))) {
    r.skipped = "flag_off";
    return r;
  }
  try {
    const codigos = await deps.repo.codigosOperacao();
    if (codigos.length === 0) throw new Error("ocorrencias_dicionario sem nenhum código da Operação — rodada abortada");
    // Setores na fila (mig 441). Sem a RPC / vazio = só OPERACAO pelo dicionário (o de antes).
    let setoresNaFila: SetorNaFila[] = [];
    let reterFechamento: string | null = null;
    if (deps.repo.setoresNaFila) {
      try {
        setoresNaFila = sanearSetoresNaFila(await deps.repo.setoresNaFila());
      } catch (e) {
        r.erros.push(`setores na fila: ${e instanceof Error ? e.message : String(e)}`);
        reterFechamento = "setores da fila indisponíveis (segue só OPERACAO)";
      }
    }
    if (deps.repo.setoresNaFila) r.setores_na_fila = setoresNaFila.length > 0 ? setoresNaFila.map((s) => s.setor) : ["OPERACAO"];
    const leitura = await deps.bastao.fetchPendenciasDaOperacao(
      setoresNaFila.length > 0
        ? {
          codigosOperacao: [...new Set(setoresNaFila.flatMap((s) => s.codigos))].sort((a, b) => a - b),
          setores: setoresNaFila.map((s) => s.setor.toLowerCase()),
        }
        : { codigosOperacao: codigos },
    );
    r.pendencias_bastao = leitura.pendencias.length;
    r.leitura_completa = leitura.completo;
    if (leitura.erro) r.erros.push(`bastao: ${leitura.erro}`);
    if (!leitura.completo && leitura.pendencias.length === 0) throw new Error(`Bastão indisponível: ${leitura.erro ?? "sem dados"}`);

    // A cerca do Relacionamento é lida ANTES de planejar; falha aqui para a rodada
    // (sem a lista de cards ativos, a fila poderia mostrar nota com tratativa aberta).
    const [cardsAtivos, abertos, encerrados, regrasUnidade, lancaveis, encaminhados, noEspelho] = await Promise.all([
      deps.repo.ctrcsComCardAtivo(),
      deps.repo.itensAbertos(),
      deps.repo.encerradosPorCtrc24h(),
      deps.repo.regrasUnidade(),
      deps.repo.codigosLancaveisAtivos(),
      deps.repo.ctrcsEncaminhamentoPendente ? deps.repo.ctrcsEncaminhamentoPendente() : Promise.resolve(new Set<string>()),
      deps.repo.ctrcsNoEspelho ? deps.repo.ctrcsNoEspelho() : Promise.resolve(new Map<string, number | null>()),
    ]);
    // Regra aprendida é conveniência: falhou a leitura → segue só com as fixas (o agente cobre).
    let regrasAprendidas: RegraAprendidaOperacao[] = [];
    if (deps.repo.regrasAprendidas) {
      try {
        regrasAprendidas = await deps.repo.regrasAprendidas();
      } catch (e) {
        r.erros.push(`regras aprendidas: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const plano = planejarMaterializacao({
      pendencias: leitura.pendencias,
      codigosOperacao: new Set(codigos),
      setoresNaFila,
      reterFechamento,
      ctrcsComCardAtivo: cardsAtivos,
      itensAbertos: abertos,
      encerradosPorCtrc24h: encerrados,
      regrasUnidade,
      codigosLancaveisAtivos: lancaveis,
      regrasSugestao: deps.regrasSugestao,
      regrasAprendidas,
      ctrcsEncaminhamentoPendente: encaminhados,
      espelhoOcPorCtrc: noEspelho,
      agoraMs: agora().getTime(),
      leituraCompleta: leitura.completo,
    });
    r.upserts = plano.upserts.length;
    r.encerrar = plano.encerrar.length;
    r.confirmar = plano.confirmar.length;
    r.bloqueados_loop = plano.bloqueados_loop.length;
    r.fechamento_retido = plano.fechamento_retido;
    r.ignorados = plano.ignorados;

    // Encerrar e confirmar vão no PRIMEIRO lote (pequenos); upserts em lotes.
    const lotes = Math.max(1, Math.ceil(plano.upserts.length / LOTE_APLICAR));
    for (let i = 0; i < lotes; i++) {
      const res = await deps.repo.aplicar({
        upserts: plano.upserts.slice(i * LOTE_APLICAR, (i + 1) * LOTE_APLICAR),
        encerrar: i === 0 ? plano.encerrar : [],
        confirmar: i === 0 ? plano.confirmar : [],
        bloqueados: i === 0 ? plano.bloqueados_loop : [],
      });
      for (const [k, v] of Object.entries(res)) r.aplicado[k] = (r.aplicado[k] ?? 0) + (Number(v) || 0);
    }
    r.ok = true;
  } catch (e) {
    r.erros.push(e instanceof Error ? e.message : String(e));
  }
  try {
    await deps.repo.registrarRodada({ iniciadoEm, ok: r.ok, resumo: { ...r } });
  } catch (e) {
    r.erros.push(`registrarRodada: ${e instanceof Error ? e.message : String(e)}`);
  }
  return r;
}
