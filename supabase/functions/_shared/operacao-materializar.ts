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
  type RegraSugestaoOperacao,
  sugerirLancamentoOperacao,
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
  sugestao: SugestaoOperacao | null;
  snapshot_hash: string;
  novo: boolean;
}

export type MotivoEncerramento =
  | "saiu_da_operacao"
  | "card_relacionamento_ativo"
  | "nota_finalizada"
  | "oc_documental";

export interface PlanoMaterializacao {
  upserts: UpsertItem[];
  encerrar: Array<{ op_item_id: string; ctrc: string; motivo: MotivoEncerramento }>;
  confirmar: Array<{ lancamento_id: string; oc_vista: number }>;
  bloqueados_loop: string[];
  /** Fechamento em massa suspeito: nada foi encerrado por "saiu da operação". */
  fechamento_retido: string | null;
  ignorados: Record<string, number>;
}

/** Pura: a pendência é da Operação? Mesma hierarquia do state_pelo_bastao (mig 029). */
export function ehDaOperacao(p: Pick<PendenciaOperacao, "responsavel_atual" | "cod_ultima_ocorrencia">, codigosOperacao: ReadonlySet<number>): boolean {
  const resp = (p.responsavel_atual ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  if (resp) return resp === "operacao";
  return p.cod_ultima_ocorrencia !== null && codigosOperacao.has(p.cod_ultima_ocorrencia);
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

/** Pura e estável: muda quando algo que a tela mostra muda. */
export function hashSnapshot(u: Omit<UpsertItem, "snapshot_hash" | "novo">): string {
  return JSON.stringify([
    u.nf, u.unidade, u.cod_ultima_ocorrencia, u.instrucao_ultima_ocorrencia, u.data_ultima_ocorrencia,
    u.responsavel_atual, u.pagador, u.destinatario, u.cidade_destino, u.uf_destino, u.previsao_entrega,
    u.atraso_original, u.qtd_volumes, u.sugestao ? [u.sugestao.regra_id, u.sugestao.codigo, u.sugestao.lancavel] : null,
  ]);
}

function conta(m: Record<string, number>, k: string): void {
  m[k] = (m[k] ?? 0) + 1;
}

export function planejarMaterializacao(args: {
  pendencias: readonly PendenciaOperacao[];
  /** Códigos com responsabilidade 'Operação' no ocorrencias_dicionario. */
  codigosOperacao: ReadonlySet<number>;
  /** CTRCs (normalizados) com card ATIVO no Relacionamento. */
  ctrcsComCardAtivo: ReadonlySet<string>;
  itensAbertos: readonly ItemAberto[];
  /** CTRC → nº de itens ENCERRADOS criados nas últimas 24 h (guard INV-040). */
  encerradosPorCtrc24h: ReadonlyMap<string, number>;
  regrasUnidade: readonly RegraUnidade[];
  codigosLancaveisAtivos: ReadonlySet<number>;
  regrasSugestao?: readonly RegraSugestaoOperacao[];
  agoraMs: number;
  /** false quando a leitura do Bastão parou no meio: nada encerra por "sumiu". */
  leituraCompleta?: boolean;
}): PlanoMaterializacao {
  const plano: PlanoMaterializacao = {
    upserts: [], encerrar: [], confirmar: [], bloqueados_loop: [], fechamento_retido: null, ignorados: {},
  };
  const abertosPorCtrc = new Map(args.itensAbertos.map((i) => [i.ctrc, i]));
  const vistosNaOperacao = new Set<string>();

  for (const p of args.pendencias) {
    const ctrc = normalizarCtrcOp(p.ctrc);
    if (!ctrc) { conta(plano.ignorados, "sem_ctrc"); continue; }
    if (vistosNaOperacao.has(ctrc)) { conta(plano.ignorados, "ctrc_repetido_no_bastao"); continue; }
    if (!ehDaOperacao(p, args.codigosOperacao)) { conta(plano.ignorados, "nao_e_da_operacao"); continue; }
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
    const sugestao = sugerirLancamentoOperacao({
      item: { cod_ultima_ocorrencia: oc, data_ultima_ocorrencia: p.data_ultima_ocorrencia, unidade },
      regras: args.regrasSugestao,
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
      sugestao,
    };
    const hash = hashSnapshot(base);
    if (aberto && aberto.snapshot_hash === hash) { conta(plano.ignorados, "sem_mudanca"); continue; }
    plano.upserts.push({ ...base, snapshot_hash: hash, novo: !aberto });
  }

  // Itens abertos que não estão mais na lista da Operação.
  const sumiram = args.itensAbertos.filter((i) =>
    !vistosNaOperacao.has(i.ctrc) && !plano.encerrar.some((e) => e.op_item_id === i.id)
  );
  const n = args.itensAbertos.length;
  if (sumiram.length > 0) {
    if (args.leituraCompleta === false) {
      plano.fechamento_retido = `leitura do Bastão incompleta; ${sumiram.length} item(ns) fora da lista não foram encerrados`;
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
  /** CTRCs (normalizados) com card ATIVO. Lança em erro → a rodada para (fail-closed). */
  ctrcsComCardAtivo(): Promise<Set<string>>;
  itensAbertos(): Promise<ItemAberto[]>;
  encerradosPorCtrc24h(): Promise<Map<string, number>>;
  regrasUnidade(): Promise<RegraUnidade[]>;
  codigosLancaveisAtivos(): Promise<Set<number>>;
  /** RPC op_materializar_aplicar (uma transação por lote). */
  aplicar(lote: { upserts: UpsertItem[]; encerrar: PlanoMaterializacao["encerrar"]; confirmar: PlanoMaterializacao["confirmar"]; bloqueados: string[] }): Promise<Record<string, number>>;
  registrarRodada(r: { iniciadoEm: string; ok: boolean; resumo: Record<string, unknown> }): Promise<void>;
}

export interface FonteBastaoOperacao {
  fetchPendenciasDaOperacao(opts: { codigosOperacao: readonly number[] }): Promise<{
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
    const leitura = await deps.bastao.fetchPendenciasDaOperacao({ codigosOperacao: codigos });
    r.pendencias_bastao = leitura.pendencias.length;
    r.leitura_completa = leitura.completo;
    if (leitura.erro) r.erros.push(`bastao: ${leitura.erro}`);
    if (!leitura.completo && leitura.pendencias.length === 0) throw new Error(`Bastão indisponível: ${leitura.erro ?? "sem dados"}`);

    // A cerca do Relacionamento é lida ANTES de planejar; falha aqui para a rodada
    // (sem a lista de cards ativos, a fila poderia mostrar nota com tratativa aberta).
    const [cardsAtivos, abertos, encerrados, regrasUnidade, lancaveis] = await Promise.all([
      deps.repo.ctrcsComCardAtivo(),
      deps.repo.itensAbertos(),
      deps.repo.encerradosPorCtrc24h(),
      deps.repo.regrasUnidade(),
      deps.repo.codigosLancaveisAtivos(),
    ]);
    const plano = planejarMaterializacao({
      pendencias: leitura.pendencias,
      codigosOperacao: new Set(codigos),
      ctrcsComCardAtivo: cardsAtivos,
      itensAbertos: abertos,
      encerradosPorCtrc24h: encerrados,
      regrasUnidade,
      codigosLancaveisAtivos: lancaveis,
      regrasSugestao: deps.regrasSugestao,
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
