// =============================================================================
// operacao-vigia — o vigia da fila da Operação no health-check (ADR 0041; INV-058).
// "Toda fila de trabalho tem vigia": a fila do SSW da Operação (op_lancamentos) e
// o materializador entram no health-check junto com o consumidor. PURO: recebe o
// resumo da RPC op_vigia_resumo (mig 430) e devolve os alertas. Flags OFF = nada.
// =============================================================================

export interface ResumoVigiaOperacao {
  flag_fila: boolean;
  flag_lancar: boolean;
  fila_parada_30min: number;
  lancando_travado: number;
  lancado_sem_confirmar_6h: number;
  nao_confirmados_24h: number;
  erros_24h: number;
  sessao_invalida_24h: number;
  ultima_materializacao_ok: string | null;
  itens_abertos: number;
}

export interface AlertaVigiaOperacao {
  tipo: string;
  chave: string;
  titulo: string;
  detalhes: string;
  payload: Record<string, unknown>;
}

/** Materializador sem rodada boa há mais que isto, com a flag ligada → alerta. */
export const MATERIALIZACAO_ATRASADA_MIN = 45;
/** Erros de lançamento em 24 h a partir dos quais vale acordar alguém. */
export const ERROS_24H_ALERTA = 3;

export function alertasVigiaOperacao(r: ResumoVigiaOperacao | null, agoraMs: number): AlertaVigiaOperacao[] {
  if (!r) return [];
  const out: AlertaVigiaOperacao[] = [];
  const base = (tipo: string, titulo: string, detalhes: string): AlertaVigiaOperacao => ({
    tipo, chave: tipo, titulo, detalhes, payload: { ...r },
  });
  if (r.flag_lancar) {
    if (r.fila_parada_30min > 0) {
      out.push(base("operacao_fila_ssw_parada", `${r.fila_parada_30min} lançamento(s) da Operação parados na fila há 30+ min`,
        "O worker processar-lancamentos-operacao não está drenando: conferir o cron (mig 433), o pulso (INV-156) e a quarentena de login."));
    }
    if (r.lancando_travado > 0) {
      out.push(base("operacao_lancamento_travado", `${r.lancando_travado} lançamento(s) da Operação travados no meio`,
        "Reservados há 15+ min sem terminar. Viram erro na próxima rodada e NÃO são relançados: conferir no SSW."));
    }
    if (r.lancado_sem_confirmar_6h > 0) {
      out.push(base("operacao_sem_confirmacao", `${r.lancado_sem_confirmar_6h} lançamento(s) da Operação sem confirmação há 6+ h`,
        "Nem o Bastão nem a leitura do SSW confirmaram a oc. Conferir o histórico do CTRC."));
    }
    if (r.nao_confirmados_24h > 0) {
      out.push(base("operacao_nao_confirmado", `${r.nao_confirmados_24h} lançamento(s) da Operação NÃO confirmados em 24 h`,
        "A leitura do SSW não mostrou a oc lançada. Alguém precisa conferir no SSW — o sistema não relança."));
    }
    if (r.erros_24h >= ERROS_24H_ALERTA || r.sessao_invalida_24h > 0) {
      out.push(base("operacao_erros_lancamento", `${r.erros_24h} erro(s) de lançamento da Operação em 24 h (login recusado: ${r.sessao_invalida_24h})`,
        "Login recusado põe a fila em quarentena de 30 min (INV-159 d). Conferir a conta ai.salex antes de insistir."));
    }
  }
  if (r.flag_fila) {
    const ult = r.ultima_materializacao_ok ? Date.parse(r.ultima_materializacao_ok) : NaN;
    if (!Number.isFinite(ult) || agoraMs - ult > MATERIALIZACAO_ATRASADA_MIN * 60_000) {
      out.push(base("operacao_materializacao_atrasada", "A fila da Operação não é atualizada do Bastão há 45+ min",
        "materializar-fila-operacao sem rodada OK: conferir o cron (mig 432), o Bastão e op_materializacoes."));
    }
  }
  return out;
}
