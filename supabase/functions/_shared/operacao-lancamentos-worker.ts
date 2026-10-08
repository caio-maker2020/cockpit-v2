// =============================================================================
// operacao-lancamentos-worker — leva ao SSW o que a Operação pediu (ADR 0041, D7).
//
// Roda na edge `processar-lancamentos-operacao` (cron de 1 min, mig 433). Sem I/O
// próprio: repositório, envelope e leitura do SSW são injetados → deno test.
//
// Nada sai sem clique humano: o worker só processa linhas de op_lancamentos, e
// essas linhas só nascem pelas RPCs op_solicitar_lancamento / op_aceitar_sugestao,
// chamadas com a sessão de um membro da Operação e com o token da prévia que ele
// confirmou. O worker não cria lançamento, não escolhe código e não escreve texto.
//
// Rodada (flag `operacao_lancar_ssw` OFF = nada roda, nem leitura):
//   0. prazos: fila parada > 4 h → erro (expirado); reservado e não terminado em
//      15 min → erro (lançamento interrompido) — NUNCA relançado às cegas;
//   1. SSW: reserva no máximo LIMITE por janela de 60 s (RPC com advisory lock e
//      teto 3, contagem global junto com a ponte), relê a cerca de cada um (card
//      ativo do Relacionamento, código ainda na lista, item ainda aberto), relê o
//      FREIO (a flag) imediatamente antes de cada ida ao SSW e lança UM POR VEZ
//      pelo envelope `lancarSswPortalOperacao`. Login recusado → quarentena;
//   2. confirmação: o lançamento confirma quando o Bastão mostra a oc (o
//      materializador faz isso). Só depois de 90 min sem essa leitura o worker
//      pergunta ao SSW (`descobrirUltimaOcSsw`), no máximo 1 por rodada. A
//      resposta nunca relança: ou confirma, ou marca `nao_confirmado` para uma
//      pessoa conferir.
// =============================================================================

import type { LancarSswPortalOperacaoResult } from "./lancar-ssw-portal-operacao.ts";
import {
  CONFIRMACAO_MAX_TENTATIVAS,
  CONFIRMACAO_TIMEOUT_MIN,
  CONFIRMACOES_POR_RODADA,
  FLAG_OPERACAO_LANCAR_SSW,
  LANCAMENTO_TRAVADO_MIN,
  LIMITE_SSW_POR_MINUTO,
  QUARENTENA_LOGIN_MIN,
  TTL_LANCAMENTO_HORAS,
} from "./operacao-comum.ts";

export interface LancamentoRow {
  id: string;
  op_item_id: string;
  ctrc: string;
  nf: string | null;
  codigo_oc: number;
  texto_operador: string;
  texto_ssw: string;
  solicitado_por: string;
  solicitado_por_nome: string;
  status: "fila" | "lancando" | "lancado" | "confirmado" | "nao_confirmado" | "recusado" | "erro" | "cancelado";
  lancado_em: string | null;
  confirmacao_tentativas: number;
}

export interface CercaNaHora {
  /** O CTRC ganhou card ATIVO no Relacionamento depois do pedido. */
  cardAtivo: boolean;
  /** O código continua ativo em op_codigos_lancaveis (e é da Operação no dicionário). */
  codigoAtivo: boolean;
  /** O item continua aberto na fila. */
  itemAberto: boolean;
  /** A NF do item hoje (pode ter chegado depois). */
  nfItem: string | null;
}

export type StatusFinal = "lancado" | "recusado" | "erro";

export interface RepoLancamentosOp {
  flagLigada(key: string): Promise<boolean>;
  expirar(ttlHoras: number, travadoMin: number): Promise<number>;
  reservar(limitePorMinuto: number, ttlHoras: number, quarentenaMin: number): Promise<LancamentoRow[]>;
  devolverParaFila(ids: string[]): Promise<void>;
  cercaNaHora(l: LancamentoRow): Promise<CercaNaHora>;
  /** RPC atômica: só finaliza lançamento em `lancando`; grava o evento do item. */
  finalizar(id: string, r: { status: StatusFinal; detalhe: string; categoria: string | null; acaoSswId: string | null; protocolo: string | null }): Promise<boolean>;
  aConfirmar(timeoutMin: number, limite: number): Promise<LancamentoRow[]>;
  registrarConfirmacao(id: string, r: { resultado: "confirmado" | "nao_confirmado" | "tentar_de_novo"; ocVista: number | null; detalhe: string }): Promise<void>;
}

export type LeituraUltimaOc =
  | { sucesso: true; oc: number; ocorrencias?: Array<{ codigo: number | null; usuario: string | null; data: string | null }> }
  | { sucesso: false; motivo: string; detalhe?: string };

export interface DepsWorkerOp {
  repo: RepoLancamentosOp;
  /** O ENVELOPE da Operação — a única porta para o SSW. */
  lancar(args: { item: { id: string; ctrc: string; nf: string }; lancamentoId: string; codigoSsw: number; textoOperador: string; textoSsw: string }): Promise<LancarSswPortalOperacaoResult>;
  /** `descobrirUltimaOcSsw` (conta de serviço). Só para confirmar, nunca para decidir lançar. */
  lerUltimaOc(nf: string, ctrc: string): Promise<LeituraUltimaOc>;
  /** Usuário SSW da conta de serviço (ai.salex), para reconhecer o próprio lançamento no histórico. */
  usuarioServico?: string | null;
  limitePorMinuto?: number;
}

export interface ResumoWorkerOp {
  skipped: string | null;
  expirados: number;
  reservados: number;
  lancados: number;
  recusados: number;
  erros: number;
  quarentena: boolean;
  confirmados: number;
  nao_confirmados: number;
  confirmacoes_adiadas: number;
  falhas: string[];
}

/** Pura: resultado do envelope → status do lançamento. */
export function interpretarResultado(codigo: number, r: LancarSswPortalOperacaoResult): {
  status: StatusFinal; detalhe: string; categoria: string | null; acaoSswId: string | null; protocolo: string | null; quarentena: boolean;
} {
  if (r.ok) {
    return {
      status: "lancado",
      detalhe: r.idempotent_skip
        ? `oc ${codigo} já estava lançada (idempotência do envelope, ${r.protocolo}); aguardando confirmação`
        : `oc ${codigo} lançada no SSW (${r.protocolo}); aguardando confirmação`,
      categoria: null,
      acaoSswId: r.acao_id,
      protocolo: r.protocolo,
      quarentena: false,
    };
  }
  const decisao = r.categoria === "guard_tripe" || r.categoria === "guard_codigo" || r.categoria === "texto_obrigatorio";
  return {
    status: decisao ? "recusado" : "erro",
    detalhe: `${r.categoria}: ${r.error}`.slice(0, 500),
    categoria: r.categoria,
    acaoSswId: r.acao_id ?? null,
    protocolo: null,
    quarentena: r.categoria === "sessao_invalida",
  };
}

/** Pura: a cerca relida na hora. null = pode lançar. */
export function recusaPelaCerca(c: CercaNaHora, l: Pick<LancamentoRow, "codigo_oc" | "nf">): { categoria: string; motivo: string } | null {
  if (c.cardAtivo) {
    return { categoria: "card_relacionamento_ativo", motivo: "a nota ganhou tratativa aberta no Relacionamento antes do lançamento; nada foi enviado" };
  }
  if (!c.codigoAtivo) {
    return { categoria: "codigo_saiu_da_lista", motivo: `a oc ${l.codigo_oc} saiu da lista da Operação antes do lançamento` };
  }
  if (!c.itemAberto) return { categoria: "item_encerrado", motivo: "o item saiu da fila da Operação antes do lançamento" };
  if (!(l.nf ?? c.nfItem)) return { categoria: "sem_nf_para_tripe", motivo: "sem NF para o tripé" };
  return null;
}

/**
 * Pura: o que a leitura do SSW diz do lançamento. NUNCA devolve "relançar".
 *   - a última oc do SSW é a lançada → confirmado;
 *   - o histórico recente (3 primeiras) mostra a oc lançada pela conta de serviço →
 *     confirmado (outra oc entrou por cima depois, e a nossa está lá);
 *   - a leitura funcionou e a oc não aparece → nao_confirmado (alguém confere);
 *   - a leitura falhou → tenta de novo, até CONFIRMACAO_MAX_TENTATIVAS; depois nao_confirmado.
 */
export function decidirConfirmacao(args: {
  codigo: number;
  leitura: LeituraUltimaOc;
  tentativasAntes: number;
  usuarioServico?: string | null;
}): { resultado: "confirmado" | "nao_confirmado" | "tentar_de_novo"; ocVista: number | null; detalhe: string } {
  const { codigo, leitura } = args;
  if (!leitura.sucesso) {
    const tentativas = args.tentativasAntes + 1;
    if (tentativas >= CONFIRMACAO_MAX_TENTATIVAS) {
      return { resultado: "nao_confirmado", ocVista: null, detalhe: `não foi possível ler o SSW em ${tentativas} tentativas (${leitura.motivo}); conferir no histórico do CTRC — nada foi relançado` };
    }
    return { resultado: "tentar_de_novo", ocVista: null, detalhe: `leitura do SSW falhou (${leitura.motivo}); nova tentativa adiante` };
  }
  if (leitura.oc === codigo) {
    return { resultado: "confirmado", ocVista: leitura.oc, detalhe: `o SSW mostra a oc ${codigo} como a última` };
  }
  const usuario = (args.usuarioServico ?? "").trim().toLowerCase();
  const recente = (leitura.ocorrencias ?? []).slice(0, 3);
  if (usuario && recente.some((o) => o.codigo === codigo && (o.usuario ?? "").trim().toLowerCase() === usuario)) {
    return { resultado: "confirmado", ocVista: leitura.oc, detalhe: `a oc ${codigo} está no histórico recente pela conta de serviço; a oc ${leitura.oc} entrou depois` };
  }
  return {
    resultado: "nao_confirmado",
    ocVista: leitura.oc,
    detalhe: `o SSW mostra a oc ${leitura.oc}, não a ${codigo}; conferir no histórico do CTRC — nada foi relançado`,
  };
}

/** Freio de emergência: true = pode ir ao SSW. Lido antes de CADA ida ao SSW. */
export async function freioLiberadoOp(repo: Pick<RepoLancamentosOp, "flagLigada">): Promise<boolean> {
  return await repo.flagLigada(FLAG_OPERACAO_LANCAR_SSW);
}

export async function rodarWorkerLancamentosOperacao(deps: DepsWorkerOp): Promise<ResumoWorkerOp> {
  const { repo } = deps;
  const resumo: ResumoWorkerOp = {
    skipped: null, expirados: 0, reservados: 0, lancados: 0, recusados: 0, erros: 0, quarentena: false,
    confirmados: 0, nao_confirmados: 0, confirmacoes_adiadas: 0, falhas: [],
  };
  if (!(await repo.flagLigada(FLAG_OPERACAO_LANCAR_SSW))) {
    resumo.skipped = "flag_off";
    return resumo;
  }

  // 0. prazos
  try {
    resumo.expirados = await repo.expirar(TTL_LANCAMENTO_HORAS, LANCAMENTO_TRAVADO_MIN);
  } catch (e) {
    resumo.falhas.push(`expirar: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 1. SSW — vazão limitada, um por vez, sempre pelo envelope.
  const reservados = await repo.reservar(deps.limitePorMinuto ?? LIMITE_SSW_POR_MINUTO, TTL_LANCAMENTO_HORAS, QUARENTENA_LOGIN_MIN);
  resumo.reservados = reservados.length;
  for (let i = 0; i < reservados.length; i++) {
    const l = reservados[i]!;
    try {
      const cerca = await repo.cercaNaHora(l);
      const recusa = recusaPelaCerca(cerca, l);
      if (recusa) {
        await repo.finalizar(l.id, { status: "recusado", detalhe: recusa.motivo, categoria: recusa.categoria, acaoSswId: null, protocolo: null });
        resumo.recusados++;
        continue;
      }
      // FREIO: relido imediatamente antes de cada ida ao SSW, dentro do laço.
      if (!(await freioLiberadoOp(repo))) {
        await repo.devolverParaFila(reservados.slice(i).map((x) => x.id));
        resumo.falhas.push("operacao_lancar_ssw desligada no meio da rodada — reservados voltaram para a fila");
        return resumo;
      }
      const nf = (l.nf ?? cerca.nfItem)!;
      const r = await deps.lancar({
        item: { id: l.op_item_id, ctrc: l.ctrc, nf },
        lancamentoId: l.id,
        codigoSsw: l.codigo_oc,
        textoOperador: l.texto_operador,
        textoSsw: l.texto_ssw,
      });
      const it = interpretarResultado(l.codigo_oc, r);
      await repo.finalizar(l.id, { status: it.status, detalhe: it.detalhe, categoria: it.categoria, acaoSswId: it.acaoSswId, protocolo: it.protocolo });
      if (it.status === "lancado") resumo.lancados++;
      else if (it.status === "recusado") resumo.recusados++;
      else resumo.erros++;
      if (it.quarentena) {
        resumo.quarentena = true;
        const resto = reservados.slice(i + 1).map((x) => x.id);
        if (resto.length > 0) await repo.devolverParaFila(resto);
        break;
      }
    } catch (e) {
      // Erro DEPOIS da reserva: fica em `lancando` e a etapa 0 o transforma em erro
      // (lançamento interrompido) — nunca relançado às cegas.
      resumo.falhas.push(`lancar ${l.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. confirmação pelo SSW, só depois do timeout e nunca em quarentena.
  if (resumo.quarentena) return resumo;
  let pendentes: LancamentoRow[] = [];
  try {
    pendentes = await repo.aConfirmar(CONFIRMACAO_TIMEOUT_MIN, CONFIRMACOES_POR_RODADA);
  } catch (e) {
    resumo.falhas.push(`aConfirmar: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const l of pendentes.slice(0, CONFIRMACOES_POR_RODADA)) {
    try {
      if (!(await freioLiberadoOp(repo))) break;
      const leitura: LeituraUltimaOc = l.nf ? await deps.lerUltimaOc(l.nf, l.ctrc) : { sucesso: false, motivo: "sem_nf" };
      const d = decidirConfirmacao({ codigo: l.codigo_oc, leitura, tentativasAntes: l.confirmacao_tentativas, usuarioServico: deps.usuarioServico });
      await repo.registrarConfirmacao(l.id, d);
      if (d.resultado === "confirmado") resumo.confirmados++;
      else if (d.resultado === "nao_confirmado") resumo.nao_confirmados++;
      else resumo.confirmacoes_adiadas++;
    } catch (e) {
      resumo.falhas.push(`confirmar ${l.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return resumo;
}
