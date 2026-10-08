// =============================================================================
// ponte-operacao-worker — o executor dos pedidos da operação (ADR 0039, D2/D5).
// Roda na edge `processar-pedidos-operacao` (cron de 1 min, mig 419). Sem I/O
// próprio: repositório, Bastão, resolver de operador e o ENVELOPE do SSW são
// injetados → deno test.
//
// Etapas de cada rodada (flag `ponte_operacao_pedidos` OFF = nada roda):
//   0. expira pedidos parados (TTL) e lançamentos interrompidos — NUNCA relança
//      às cegas: pedido que estava no meio do lançamento vira `erro` e alguém
//      confere no SSW (duplicar ocorrência é pior que atrasar);
//   A. vincula o pedido ao card do CTRC — achando o ativo, ou CRIANDO o card a
//      partir do Bastão (só `devolver_ao_relacionamento`; nunca SSW aqui);
//   B. decide: com `ponte_operacao_lancar_ssw` OFF o `devolver` termina só com o
//      evento no card; com ON, entra na fila do SSW;
//   C. SSW — só com a flag ON: reserva no máximo LIMITE_SSW_POR_MINUTO pedidos
//      por janela de 60 s (RPC com advisory lock, contagem global), e lança UM
//      POR VEZ pelo envelope `lancarSswPortal` (idempotência + tripé + conta de
//      serviço). Login falhou → quarentena de 30 min (INV-159 d: esperar).
// =============================================================================

import type { LancarSswPortalResult } from "./lancar-ssw-portal.ts";
import {
  ehTerminal,
  FLAG_PONTE_OPERACAO_LANCAR_SSW,
  FLAG_PONTE_OPERACAO_PEDIDOS,
  normalizarCtrc,
  normalizarNf,
} from "./ponte-operacao-comum.ts";
import { OCS_EXTRAVIO } from "./ponte-operacao-bloqueio.ts";
// INV-040: a MESMA decisão e o MESMO limite do guard anti-loop do sync (ADR 0038).
import { excedeuLimiteLoopCriacao, LIMITE_TERMINAIS_24H } from "./guard-anti-loop-criacao.ts";
import {
  CODIGO_DEVOLVER,
  type CardResumo,
  OCS_FINALIZADORAS_PONTE,
  type PedidoRow,
  type StatusPedido,
} from "./ponte-operacao-pedido.ts";

// ── vazão e prazos ───────────────────────────────────────────────────────────
/** Lançamentos por minuto que o worker PEDE. Cada lançamento = 1 login no máximo (sessão em cache). */
export const LIMITE_SSW_POR_MINUTO = 2;
/** Teto duro, repetido na RPC da mig 418: nem com parâmetro errado passa disso. */
export const TETO_SSW_POR_MINUTO = 3;
export const JANELA_VAZAO_SEGUNDOS = 60;
/** Depois de um login recusado, ninguém da ponte abre sessão por este tempo. */
export const QUARENTENA_LOGIN_MIN = 30;
/** Pedido que não terminou neste prazo vira `erro` — pedido da rota de hoje não vale amanhã. */
export const TTL_PEDIDO_HORAS = 4;
/** Reservado para lançar e não terminou (worker morreu no meio) → `erro`, conferir no SSW. */
export const LANCAMENTO_TRAVADO_MIN = 15;
export const LIMITE_VINCULAR_POR_RODADA = 20;
export const LIMITE_DECIDIR_POR_RODADA = 50;
/** Outro pedido já lançou a mesma oc no mesmo CTRC neste prazo → duplicado. */
export const JANELA_DUPLICIDADE_HORAS = 12;
/** O limite do guard anti-loop INV-040, importado (não copiado) de guard-anti-loop-criacao.ts. */
export const LIMITE_TERMINAIS_24H_PONTE = LIMITE_TERMINAIS_24H;

export const EVENTO_DEVOLVIDO = "DevolvidoPelaOperacao" as const;
export const EVENTO_OCORRENCIA_SOLICITADA = "OcorrenciaSolicitadaPelaOperacao" as const;
export const EVENTO_CARD_CRIADO = "CardCriadoPorPedidoOperacao" as const;
export const EVENTO_LANCADO = "PedidoOperacaoLancadoNoSsw" as const;
export const EVENTO_NAO_EXECUTADO = "PedidoOperacaoNaoExecutado" as const;

/** Pura: quantos pedidos podem ir ao SSW agora. Mesma conta da RPC `ponte_operacao_reservar_lancamentos`. */
export function vagasDeLancamento(args: {
  limitePorMinuto: number;
  reservadosNaJanela: number;
  emQuarentena: boolean;
}): number {
  if (args.emQuarentena) return 0;
  const lim = Math.max(0, Math.min(TETO_SSW_POR_MINUTO, Math.floor(Number(args.limitePorMinuto) || 0)));
  return Math.max(0, lim - Math.max(0, Math.floor(args.reservadosNaJanela)));
}

// ── nascimento do card (ADR 0039, D2) ────────────────────────────────────────

export interface PendenciaBastaoMin {
  id: string;
  ctrc: string | null;
  nf: string | null;
  cod_ultima_ocorrencia: number | null;
  instrucao_ultima_ocorrencia: string | null;
  data_ultima_ocorrencia: string | null;
  pagador: string | null;
  cnpj_pagador: string | null;
  cnpj_remetente: string | null;
  base_destino: string | null;
  responsavel_relacionamento: string | null;
  segmento_cliente: string | null;
  tipo_documento: string | null;
  qtd_volumes: number | null;
  atraso_original: number | null;
}

export type DecisaoNascimento =
  | { cria: true; state: "AGUARDANDO_VALIDACAO_HUMANA" | "AGUARDANDO_CLIENTE"; lock: boolean }
  | { cria: false; codigo: string; motivo: string };

/**
 * Pura. O card só nasce quando há dado CONFIÁVEL (Bastão, com NF) e quando
 * nascer não fere nenhuma regra do Cockpit:
 *   - entregue/baixada (1/30/32) → não nasce (o SSW recusaria qualquer ação);
 *   - extravio (6/9/16) → não nasce: card de extravio é do sync de extravios e
 *     tem estado próprio (INV-017); a 49 do extravio é do agente (INV-022);
 *   - CNPJ fora do Cockpit (cnpjs_excluidos_cockpit) → não nasce;
 *   - oc de cliente (54/59) → nasce AGUARDANDO_CLIENTE (INV-006);
 *   - resto → nasce AGUARDANDO_VALIDACAO_HUMANA + lock: a fila do operador, e o
 *     sync-bastao não mexe no state enquanto o operador não agir (lock, mig 023).
 */
export function decidirNascimentoCard(args: {
  pendencia: PendenciaBastaoMin | null;
  ctrcPedido: string;
  ocsCliente: ReadonlySet<number>;
  atribuicaoVia?: string | null;
  /** NF que veio no pedido (emenda 1), já normalizada; null quando não veio. */
  nfPedido?: string | null;
}): DecisaoNascimento {
  const p = args.pendencia;
  if (!p) {
    // Emenda 1: sem NF, nota sem card e fora do Bastão não ganha card. COM a NF do
    // pedido também não, nesta versão: sem o Bastão não há pagador (atribuição do
    // operador, checagem de CNPJ fora do Cockpit) nem oc para o state de nascimento,
    // e buscar isso no SSW seria login a partir do pedido (INV-159). ADR 0039, D2.
    return args.nfPedido
      ? {
        cria: false,
        codigo: "sem_card_fora_do_bastao",
        motivo: `o Cockpit não tem card para este CTRC e ele não está no Bastão; só com a NF do pedido (${args.nfPedido}) ` +
          "o card não nasce (sem pagador não há atribuição). O pedido ficou registrado; fale com o Relacionamento (Criar Card manual pela NF).",
      }
      : {
        cria: false,
        codigo: "sem_nf",
        motivo: "o Cockpit não tem card para este CTRC, ele não está no Bastão e o pedido não trouxe NF; sem NF o card não nasce.",
      };
  }
  const nf = normalizarNf(p.nf);
  if (!nf) return { cria: false, codigo: "bastao_sem_nf", motivo: "a pendência do Bastão não tem NF" };
  if (args.nfPedido && args.nfPedido !== nf) {
    return { cria: false, codigo: "nf_diverge_bastao", motivo: `a NF do pedido (${args.nfPedido}) não é a do Bastão para este CTRC (${nf})` };
  }
  if (normalizarCtrc(p.ctrc) !== args.ctrcPedido) {
    return { cria: false, codigo: "ctrc_diverge_bastao", motivo: `o Bastão devolveu outro CTRC (${p.ctrc ?? "vazio"})` };
  }
  const oc = p.cod_ultima_ocorrencia;
  if (oc !== null && OCS_FINALIZADORAS_PONTE.has(oc)) {
    return { cria: false, codigo: "nota_entregue_ou_baixada", motivo: `a nota está ENTREGUE/BAIXADA no Bastão (oc ${oc})` };
  }
  if (oc !== null && OCS_EXTRAVIO.has(oc)) {
    return {
      cria: false,
      codigo: "nota_em_extravio",
      motivo: `a nota está em extravio (oc ${oc}); o card de extravio nasce pelo sync de extravios, não por pedido`,
    };
  }
  if (args.atribuicaoVia === "cnpj_excluido") {
    return { cria: false, codigo: "cnpj_fora_do_cockpit", motivo: "o CNPJ pagador está fora do Cockpit (cnpjs_excluidos_cockpit)" };
  }
  if (oc !== null && args.ocsCliente.has(oc)) return { cria: true, state: "AGUARDANDO_CLIENTE", lock: false };
  return { cria: true, state: "AGUARDANDO_VALIDACAO_HUMANA", lock: true };
}

export interface NovoCardDoPedido {
  nf: string;
  ctrc: string;
  pagador: string | null;
  base_destino: string | null;
  responsavel_relacionamento: string | null;
  assigned_operator_id: string | null;
  state: "AGUARDANDO_VALIDACAO_HUMANA" | "AGUARDANDO_CLIENTE";
  lock_aguardando_validacao: boolean;
  bastao_pendencia_id: string;
  cod_ultima_ocorrencia: number | null;
  bastao_data_ultima_ocorrencia: string | null;
  tipo_cte: string | null;
  qtde_volumes: number | null;
  agent_state: Record<string, unknown>;
}

/** Pura: mesmo formato do card que o vinculador cria do Bastão (createCardFromBastao). */
export function montarNovoCard(args: {
  pendencia: PendenciaBastaoMin;
  decisao: Extract<DecisaoNascimento, { cria: true }>;
  atribuicao: { responsavel_relacionamento: string | null; assigned_operator_id: string | null };
  pedido: Pick<PedidoRow, "pedido_id" | "ctrc">;
}): NovoCardDoPedido {
  const p = args.pendencia;
  return {
    nf: normalizarNf(p.nf)!,
    ctrc: args.pedido.ctrc,
    pagador: p.pagador,
    base_destino: p.base_destino,
    responsavel_relacionamento: args.atribuicao.responsavel_relacionamento,
    assigned_operator_id: args.atribuicao.assigned_operator_id,
    state: args.decisao.state,
    lock_aguardando_validacao: args.decisao.lock,
    bastao_pendencia_id: p.id,
    cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
    bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
    tipo_cte: p.tipo_documento,
    qtde_volumes: p.qtd_volumes,
    agent_state: {
      bastao_pendencia_id: p.id,
      cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
      instrucao_ultima_ocorrencia: p.instrucao_ultima_ocorrencia,
      cnpj_remetente: p.cnpj_remetente,
      cnpj_pagador: p.cnpj_pagador,
      dias_atraso: p.atraso_original,
      criado_via: "ponte_operacao",
      pedido_operacao_id: args.pedido.pedido_id,
    },
  };
}

// ── lançamento (ADR 0039, D5) ────────────────────────────────────────────────

export interface CardLancamento {
  id: string;
  nf: string | null;
  ctrc: string | null;
  state: string;
  cod_ultima_ocorrencia: number | null;
}

export type DecisaoLancamento =
  /** `nf` = a NF que vai ao tripé: a do CARD; a do pedido só quando o card não tem. */
  | { lancar: true; nf: string }
  | { lancar: false; status: Exclude<StatusPedido, "recebido">; codigo: string; motivo: string };

/**
 * Pura (emenda 1): qual NF vai ao tripé. A do card vence; a do pedido entra só
 * quando o card não tem NF — e aí é o próprio tripé do envelope que confere com o
 * SSW antes do submit. As duas presentes e diferentes = não lança.
 */
export function nfParaTripe(nfCard: string | null, nfPedido: string | null):
  | { ok: true; nf: string }
  | { ok: false; codigo: string; motivo: string } {
  const card = normalizarNf(nfCard);
  const pedido = normalizarNf(nfPedido);
  if (card && pedido && card !== pedido) {
    return { ok: false, codigo: "nf_diverge", motivo: `a NF do pedido (${pedido}) não é a do card (${card}); a NF do card nunca é trocada` };
  }
  if (card) return { ok: true, nf: String(nfCard).trim() };
  if (pedido) return { ok: true, nf: pedido };
  return { ok: false, codigo: "sem_nf_para_tripe", motivo: "sem NF para o tripé" };
}

/**
 * Pura. Última cerca antes do envelope, com o card RELIDO na hora (o mundo pode
 * ter mudado desde o pedido). O envelope ainda roda a dele (tripé + idempotência).
 */
export function decidirLancamento(args: {
  pedido: Pick<PedidoRow, "tipo" | "ctrc" | "codigo_ocorrencia"> & { nf?: string | null };
  card: CardLancamento | null;
  codigoAindaPermitido: boolean;
  duplicadoDe: string | null;
}): DecisaoLancamento {
  const { pedido, card } = args;
  const recusa = (codigo: string, motivo: string): DecisaoLancamento => ({ lancar: false, status: "recusado", codigo, motivo });
  if (!card) return recusa("card_sumiu", "o card do pedido não foi encontrado");
  if (normalizarCtrc(card.ctrc) !== pedido.ctrc) {
    return recusa("ctrc_diverge", `o CTRC do card (${card.ctrc ?? "vazio"}) não é o do pedido; o CTRC do card nunca é trocado`);
  }
  const nf = nfParaTripe(card.nf, pedido.nf ?? null);
  if (!nf.ok) return recusa(nf.codigo, nf.motivo);
  if (card.state === "EXECUTANDO_ACAO" || card.state === "ACAO_EXECUTADA") {
    return recusa(
      "acao_em_confirmacao",
      "o Relacionamento tem uma ação no SSW aguardando confirmação; lançar por cima quebraria a confirmação",
    );
  }
  const oc = card.cod_ultima_ocorrencia;
  if (oc !== null && OCS_FINALIZADORAS_PONTE.has(oc)) {
    return recusa("nota_entregue_ou_baixada", `a nota está ENTREGUE/BAIXADA (oc ${oc})`);
  }
  if (pedido.tipo === "devolver_ao_relacionamento") {
    if (card.state === "EXTRAVIO_MONITORADO" || (oc !== null && OCS_EXTRAVIO.has(oc))) {
      return recusa("nota_em_extravio", "nota em extravio: a 49 do extravio é do agente de extravio (INV-022); o pedido ficou no card");
    }
    if (oc === CODIGO_DEVOLVER) {
      return {
        lancar: false,
        status: "executado",
        codigo: "ja_era_49",
        motivo: "registrado no card; a 49 já é a última ocorrência no SSW, não foi relançada",
      };
    }
  } else {
    if (!args.codigoAindaPermitido) {
      return recusa("codigo_saiu_da_lista", `a oc ${pedido.codigo_ocorrencia} saiu da lista da operação antes da execução`);
    }
    if (!ehTerminal(card.state)) {
      return recusa("tratativa_aberta", "a nota ganhou tratativa aberta no Relacionamento antes da execução");
    }
  }
  if (args.duplicadoDe) return recusa("duplicado", args.duplicadoDe);
  return { lancar: true, nf: nf.nf };
}

/** Lançamento da mesma oc no mesmo card em voo (sucesso=null) há menos disto → não lança por cima. */
export const EM_VOO_MIN = 15;
/** Mesma janela do envelope (RELANCAMENTO_JANELA_SKIP_MS): lançamento recente = duplo clique. */
export const LANCAMENTO_RECENTE_MIN = 10;

export interface FatosDuplicidade {
  /** Outro pedido da ponte que JÁ lançou a mesma oc neste CTRC (janela de 12 h). */
  outroPedido: { pedido_id: string; executado_em: string | null } | null;
  /** Último registro do envelope para (card, oc), de qualquer origem (executor incluso). */
  ultimaAcao: { id: string; sucesso: boolean | null; iniciado_em: string; finalizado_em: string | null } | null;
}

/** Pura: motivo legível de duplicidade, ou null. */
export function motivoDuplicidade(f: FatosDuplicidade, codigo: number, agoraMs: number): string | null {
  if (f.outroPedido) {
    return `a oc ${codigo} já foi lançada para este CTRC pelo pedido ${f.outroPedido.pedido_id}`;
  }
  const a = f.ultimaAcao;
  if (a) {
    const ini = Date.parse(a.iniciado_em);
    if (a.sucesso === null && Number.isFinite(ini) && agoraMs - ini < EM_VOO_MIN * 60_000) {
      return `há um lançamento da oc ${codigo} em andamento neste card (acao ${a.id})`;
    }
    const fim = a.finalizado_em ? Date.parse(a.finalizado_em) : NaN;
    if (a.sucesso === true && Number.isFinite(fim) && agoraMs - fim < LANCAMENTO_RECENTE_MIN * 60_000) {
      return `o Cockpit lançou a oc ${codigo} neste card há menos de ${LANCAMENTO_RECENTE_MIN} min (acao ${a.id})`;
    }
  }
  return null;
}

/** Pura: texto que vai na Instrução do SSW (≤ 500; o portal ainda sanitiza para latin-1). */
export function montarTextoSsw(p: Pick<PedidoRow, "texto" | "base" | "solicitado_por_nome">): string {
  const origem = `pedido da operação${p.base ? ` ${p.base}` : ""} por ${p.solicitado_por_nome}`;
  return `${p.texto.trim()} (${origem})`.slice(0, 500);
}

export interface InterpretacaoLancamento {
  status: Exclude<StatusPedido, "recebido">;
  ocorrenciaLancada: number | null;
  acaoSswId: string | null;
  categoria: string | null;
  detalhe: string;
  protocolo: string | null;
  quarentena: boolean;
}

/** Pura: resultado do envelope → status do pedido. */
export function interpretarLancamento(codigo: number, r: LancarSswPortalResult): InterpretacaoLancamento {
  if (r.ok) {
    return {
      status: "executado",
      ocorrenciaLancada: codigo,
      acaoSswId: r.acao_id,
      categoria: null,
      detalhe: r.idempotent_skip
        ? `oc ${codigo} já estava lançada (idempotência do envelope, ${r.protocolo})`
        : `oc ${codigo} lançada no SSW (${r.protocolo})`,
      protocolo: r.protocolo,
      quarentena: false,
    };
  }
  const detalhe = `${r.categoria}: ${r.error}`.slice(0, 500);
  return {
    // Recusa do guard do tripé é decisão (nota encerrada / CTRC ou NF divergentes), não falha.
    status: r.categoria === "guard_tripe" ? "recusado" : "erro",
    ocorrenciaLancada: null,
    acaoSswId: r.acao_id ?? null,
    categoria: r.categoria,
    detalhe,
    protocolo: null,
    quarentena: r.categoria === "sessao_invalida",
  };
}

// ── repositório e laço ───────────────────────────────────────────────────────

export interface CardResumoWorker extends CardResumo {
  /** agent_state.pedido_operacao_id — o card nasceu deste pedido (retomada após crash). */
  pedido_operacao_id?: string | null;
}

export interface FinalizarArgs {
  status: Exclude<StatusPedido, "recebido">;
  detalhe: string;
  ocorrenciaLancada?: number | null;
  acaoSswId?: string | null;
  categoria?: string | null;
  evento?: { tipo: typeof EVENTO_LANCADO | typeof EVENTO_NAO_EXECUTADO; payload: Record<string, unknown> } | null;
}

export interface AuditPonte {
  card_id: string;
  idempotency_key: string;
  request_payload: Record<string, unknown>;
  response_payload: Record<string, unknown>;
  status: "success" | "failed";
  external_id: string | null;
}

export interface RepoWorker {
  flagLigada(key: string): Promise<boolean>;
  /** RPC: TTL + lançamento travado → erro (com evento de recusa). Devolve quantos. */
  expirarVencidos(ttlHoras: number, travadoMin: number): Promise<number>;
  pedidosParaVincular(limite: number): Promise<PedidoRow[]>;
  pedidosVinculados(limite: number): Promise<PedidoRow[]>;
  cardsDoCtrc(ctrc: string): Promise<CardResumoWorker[]>;
  cardsAtivosDaNf(nf: string): Promise<CardResumo[]>;
  terminaisDaNf24h(nf: string): Promise<number>;
  criarCard(novo: NovoCardDoPedido): Promise<{ id: string } | "conflito">;
  vincularCard(args: { pedidoId: string; cardId: string; cardCriado: boolean; payloadCriacao: Record<string, unknown> | null }): Promise<void>;
  moverParaFila(pedidoId: string): Promise<void>;
  /** RPC atômica: só finaliza pedido ainda `recebido`; grava o evento no card se houver. */
  finalizar(pedidoId: string, args: FinalizarArgs): Promise<void>;
  /** RPC com advisory lock: reserva até `vagas` pedidos da fila (contagem global da janela). */
  reservarLancamentos(limitePorMinuto: number, ttlHoras: number, quarentenaMin: number): Promise<PedidoRow[]>;
  devolverParaFila(pedidoIds: string[]): Promise<void>;
  cardParaLancar(cardId: string): Promise<CardLancamento | null>;
  /** Fatos para a regra de duplicidade (motivoDuplicidade). Lança em erro de banco → fail-closed. */
  fatosDuplicidade(pedido: PedidoRow, cardId: string, janelaHoras: number): Promise<FatosDuplicidade>;
  codigoPermitido(codigo: number): Promise<boolean>;
  registrarAudit(a: AuditPonte): Promise<void>;
}

export interface DepsWorker {
  repo: RepoWorker;
  /** Bastão por CTRC. Lança em falha de rede (o pedido espera o próximo minuto). */
  buscarPendenciaPorCtrc(ctrc: string): Promise<PendenciaBastaoMin | null>;
  resolverAtribuicao(p: PendenciaBastaoMin): Promise<{
    responsavel_relacionamento: string | null;
    assigned_operator_id: string | null;
    via: string;
  }>;
  ocsCliente: ReadonlySet<number>;
  /** O ENVELOPE (`lancarSswPortal`) — a única porta para o SSW. */
  lancar(args: { card: { id: string; nf: string; ctrc: string }; codigoSsw: number; texto: string }): Promise<LancarSswPortalResult>;
  limitePorMinuto?: number;
  agora?: () => Date;
}

export interface ResumoWorker {
  skipped: string | null;
  expirados: number;
  vinculados: number;
  cards_criados: number;
  aguardando_bastao: number;
  finalizados_sem_ssw: number;
  na_fila_ssw: number;
  reservados_ssw: number;
  lancados: number;
  recusados: number;
  erros_ssw: number;
  quarentena: boolean;
  erros: string[];
}

function solicitante(p: PedidoRow): Record<string, unknown> {
  return { id: p.solicitado_por_id, nome: p.solicitado_por_nome, email: p.solicitado_por_email };
}

function payloadEvento(p: PedidoRow, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    origem: "ponte_operacao",
    pedido_id: p.pedido_id,
    tipo: p.tipo,
    ctrc: p.ctrc,
    codigo_ocorrencia: p.codigo_ocorrencia,
    base: p.base,
    solicitado_por: solicitante(p),
    ...extra,
  };
}

async function recusar(repo: RepoWorker, p: PedidoRow, codigo: string, motivo: string, cardId: string | null): Promise<void> {
  await repo.finalizar(p.pedido_id, {
    status: "recusado",
    detalhe: motivo,
    categoria: codigo,
    evento: cardId ? { tipo: EVENTO_NAO_EXECUTADO, payload: payloadEvento(p, { codigo, motivo }) } : null,
  });
}

/** Etapa A para um pedido. Lança só em erro inesperado (o laço registra e segue). */
async function vincularOuCriar(deps: DepsWorker, p: PedidoRow, resumo: ResumoWorker): Promise<void> {
  const { repo } = deps;
  const cards = await repo.cardsDoCtrc(p.ctrc);
  const ativo = cards.find((c) => !ehTerminal(c.state)) ?? null;

  if (p.tipo === "lancar_ocorrencia") {
    if (ativo) return await recusar(repo, p, "tratativa_aberta", "a nota tem tratativa aberta no Relacionamento; use devolver_ao_relacionamento", null);
    const recente = cards[0] ?? null;
    if (!recente) return await recusar(repo, p, "sem_card", "o Cockpit não tem card para este CTRC", null);
    await repo.vincularCard({ pedidoId: p.pedido_id, cardId: recente.id, cardCriado: false, payloadCriacao: null });
    resumo.vinculados++;
    return;
  }

  if (ativo) {
    // Se o card nasceu deste pedido numa rodada que caiu antes do vínculo, o evento de criação entra agora.
    const nasceuDeste = ativo.pedido_operacao_id === p.pedido_id;
    await repo.vincularCard({
      pedidoId: p.pedido_id,
      cardId: ativo.id,
      cardCriado: nasceuDeste,
      payloadCriacao: nasceuDeste ? { retomado: true } : null,
    });
    resumo.vinculados++;
    return;
  }

  let pendencia: PendenciaBastaoMin | null;
  try {
    pendencia = await deps.buscarPendenciaPorCtrc(p.ctrc);
  } catch (e) {
    resumo.aguardando_bastao++;
    resumo.erros.push(`bastao ${p.ctrc}: ${e instanceof Error ? e.message : String(e)}`);
    return; // tenta de novo no próximo minuto, até o TTL
  }
  const previa = decidirNascimentoCard({ pendencia, ctrcPedido: p.ctrc, ocsCliente: deps.ocsCliente, nfPedido: p.nf ?? null });
  if (!previa.cria) return await recusar(repo, p, previa.codigo, previa.motivo, null);
  const pend = pendencia!;
  const nf = normalizarNf(pend.nf)!;

  const ativosDaNf = await repo.cardsAtivosDaNf(nf);
  if (ativosDaNf.length > 0) {
    const c = ativosDaNf[0]!;
    return await recusar(
      repo, p, "nf_com_card_ativo_outro_ctrc",
      `a NF ${nf} já tem card ativo (${c.id}) com CTRC ${c.ctrc ?? "vazio"}; o CTRC do card nunca é trocado — o Relacionamento decide`,
      null,
    );
  }
  // INV-040 (ADR 0038): >= 3 cards ENCERRADOS da NF criados em 24 h = rajada de fabricação.
  // Mesma decisão pura do guard do sync; a contagem é fail-CLOSED aqui (erro → o pedido
  // espera a próxima rodada, nenhum card nasce), ao contrário do sync, que é fail-open.
  if (excedeuLimiteLoopCriacao(await repo.terminaisDaNf24h(nf))) {
    return await recusar(repo, p, "loop_criacao", `a NF ${nf} teve ${LIMITE_TERMINAIS_24H_PONTE}+ cards encerrados em 24h (guard INV-040)`, null);
  }
  const atribuicao = await deps.resolverAtribuicao(pend);
  const decisao = decidirNascimentoCard({
    pendencia: pend, ctrcPedido: p.ctrc, ocsCliente: deps.ocsCliente, atribuicaoVia: atribuicao.via, nfPedido: p.nf ?? null,
  });
  if (!decisao.cria) return await recusar(repo, p, decisao.codigo, decisao.motivo, null);

  const novo = montarNovoCard({ pendencia: pend, decisao, atribuicao, pedido: p });
  const criado = await repo.criarCard(novo);
  if (criado === "conflito") {
    // Outro caminho criou o card ativo desta NF no meio: a próxima rodada vincula nele.
    resumo.aguardando_bastao++;
    return;
  }
  await repo.vincularCard({
    pedidoId: p.pedido_id,
    cardId: criado.id,
    cardCriado: true,
    payloadCriacao: {
      bastao_pendencia_id: pend.id,
      cod_ultima_ocorrencia: pend.cod_ultima_ocorrencia,
      state: novo.state,
      lock: novo.lock_aguardando_validacao,
      atribuicao_via: atribuicao.via,
    },
  });
  resumo.cards_criados++;
  resumo.vinculados++;
}

/** Freio de emergência do SSW: true = pode lançar. Lido antes de cada lançamento. */
export async function freioDeEmergenciaLiberado(repo: Pick<RepoWorker, "flagLigada">): Promise<boolean> {
  return await repo.flagLigada(FLAG_PONTE_OPERACAO_LANCAR_SSW);
}

/** Não conseguir conferir duplicidade = não lançar (duplicar ocorrência é pior que atrasar). */
async function duplicidadeFailClosed(repo: RepoWorker, p: PedidoRow, cardId: string, agora: Date): Promise<string | null> {
  try {
    const f = await repo.fatosDuplicidade(p, cardId, JANELA_DUPLICIDADE_HORAS);
    return motivoDuplicidade(f, p.codigo_ocorrencia, agora.getTime());
  } catch (e) {
    return `não foi possível conferir duplicidade (${e instanceof Error ? e.message : String(e)}); não lançado`;
  }
}

export async function rodarWorkerPedidos(deps: DepsWorker): Promise<ResumoWorker> {
  const { repo } = deps;
  const agora = deps.agora ?? (() => new Date());
  const resumo: ResumoWorker = {
    skipped: null, expirados: 0, vinculados: 0, cards_criados: 0, aguardando_bastao: 0,
    finalizados_sem_ssw: 0, na_fila_ssw: 0, reservados_ssw: 0, lancados: 0, recusados: 0,
    erros_ssw: 0, quarentena: false, erros: [],
  };
  if (!(await repo.flagLigada(FLAG_PONTE_OPERACAO_PEDIDOS))) {
    resumo.skipped = "flag_off";
    return resumo;
  }

  // 0. prazos
  try {
    resumo.expirados = await repo.expirarVencidos(TTL_PEDIDO_HORAS, LANCAMENTO_TRAVADO_MIN);
  } catch (e) {
    resumo.erros.push(`expirar: ${e instanceof Error ? e.message : String(e)}`);
  }

  // A. vincular / criar card (sem SSW)
  for (const p of await repo.pedidosParaVincular(LIMITE_VINCULAR_POR_RODADA)) {
    try {
      await vincularOuCriar(deps, p, resumo);
    } catch (e) {
      resumo.erros.push(`vincular ${p.pedido_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // B. decidir o que cada pedido vinculado ainda precisa. Esta leitura só decide a
  // etapa B; o FREIO DE EMERGÊNCIA é relido antes de cada ida ao SSW, na etapa C.
  const lancarLigado = await repo.flagLigada(FLAG_PONTE_OPERACAO_LANCAR_SSW);
  for (const p of await repo.pedidosVinculados(LIMITE_DECIDIR_POR_RODADA)) {
    try {
      if (!lancarLigado) {
        if (p.tipo === "devolver_ao_relacionamento") {
          await repo.finalizar(p.pedido_id, {
            status: "executado",
            detalhe: "registrado no card do Relacionamento; a 49 não foi lançada (lançamento no SSW desligado)",
          });
          resumo.finalizados_sem_ssw++;
        } else {
          await recusar(repo, p, "lancamento_ssw_desligado", "o lançamento no SSW foi desligado antes da execução", p.card_id);
          resumo.recusados++;
        }
        continue;
      }
      await repo.moverParaFila(p.pedido_id);
      resumo.na_fila_ssw++;
    } catch (e) {
      resumo.erros.push(`decidir ${p.pedido_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!lancarLigado) return resumo;

  // C. SSW — vazão limitada, um por vez, sempre pelo envelope.
  const reservados = await repo.reservarLancamentos(
    deps.limitePorMinuto ?? LIMITE_SSW_POR_MINUTO, TTL_PEDIDO_HORAS, QUARENTENA_LOGIN_MIN,
  );
  resumo.reservados_ssw = reservados.length;
  for (let i = 0; i < reservados.length; i++) {
    const p = reservados[i]!;
    try {
      const card = p.card_id ? await repo.cardParaLancar(p.card_id) : null;
      const d = decidirLancamento({
        pedido: p,
        card,
        codigoAindaPermitido: p.tipo === "lancar_ocorrencia" ? await repo.codigoPermitido(p.codigo_ocorrencia) : true,
        duplicadoDe: card ? await duplicidadeFailClosed(repo, p, card.id, agora()) : null,
      });
      if (!d.lancar) {
        if (d.status === "executado") {
          await repo.finalizar(p.pedido_id, { status: "executado", detalhe: d.motivo, categoria: d.codigo });
          resumo.finalizados_sem_ssw++;
        } else {
          await recusar(repo, p, d.codigo, d.motivo, card?.id ?? null);
          resumo.recusados++;
        }
        continue;
      }
      // FREIO DE EMERGÊNCIA: a flag é relida antes de CADA ida ao SSW, dentro do laço.
      // Nada roda entre esta leitura e o deps.lancar() abaixo além de montar o texto.
      if (!(await freioDeEmergenciaLiberado(repo))) {
        await repo.devolverParaFila(reservados.slice(i).map((x) => x.pedido_id));
        resumo.erros.push("ponte_operacao_lancar_ssw desligada no meio da rodada — reservados voltaram para a fila");
        break;
      }
      // CTRC sempre do CARD (regra de ouro). NF do card; a do pedido só se o card
      // não tem (nfParaTripe) — e o tripé do envelope confere com o SSW antes do submit.
      const alvo = { id: card!.id, nf: d.nf, ctrc: normalizarCtrc(card!.ctrc)! };
      const texto = montarTextoSsw(p);
      const r = await deps.lancar({ card: alvo, codigoSsw: p.codigo_ocorrencia, texto });
      const it = interpretarLancamento(p.codigo_ocorrencia, r);
      await repo.finalizar(p.pedido_id, {
        status: it.status,
        detalhe: it.detalhe,
        ocorrenciaLancada: it.ocorrenciaLancada,
        acaoSswId: it.acaoSswId,
        categoria: it.categoria,
        evento: {
          tipo: it.status === "executado" ? EVENTO_LANCADO : EVENTO_NAO_EXECUTADO,
          payload: payloadEvento(p, {
            status: it.status, detalhe: it.detalhe, categoria: it.categoria, acao_ssw_id: it.acaoSswId, protocolo: it.protocolo,
          }),
        },
      });
      try {
        await repo.registrarAudit({
          card_id: alvo.id,
          idempotency_key: `ponte_operacao:${p.pedido_id}`,
          request_payload: {
            origem: "ponte_operacao", pedido_id: p.pedido_id, tipo: p.tipo, codigo_ssw: p.codigo_ocorrencia,
            ctrc: alvo.ctrc, nf: alvo.nf, texto, base: p.base, solicitado_por: solicitante(p),
          },
          response_payload: { ok: r.ok, status: it.status, categoria: it.categoria, detalhe: it.detalhe, acao_ssw_id: it.acaoSswId },
          status: r.ok ? "success" : "failed",
          external_id: it.protocolo,
        });
      } catch (e) {
        resumo.erros.push(`audit ${p.pedido_id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (it.status === "executado") resumo.lancados++;
      else if (it.status === "recusado") resumo.recusados++;
      else resumo.erros_ssw++;
      if (it.quarentena) {
        // Login recusado: para aqui. Os já reservados voltam para a fila e a RPC
        // não reserva mais nada por QUARENTENA_LOGIN_MIN (INV-159 d).
        resumo.quarentena = true;
        const resto = reservados.slice(i + 1).map((x) => x.pedido_id);
        if (resto.length > 0) await repo.devolverParaFila(resto);
        break;
      }
    } catch (e) {
      // Erro inesperado DEPOIS da reserva: o pedido fica em `lancando_ssw` e a
      // etapa 0 o transforma em `erro` (sem relançar às cegas).
      resumo.erros.push(`lancar ${p.pedido_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return resumo;
}
