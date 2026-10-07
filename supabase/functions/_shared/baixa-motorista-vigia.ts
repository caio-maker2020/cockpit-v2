// =============================================================================
// baixa-motorista-vigia — o vigia da fila da baixa do motorista (INV-058, ADR 0040).
//
// "Toda fila de trabalho tem vigia": a fila da baixa é a tabela baixas_motorista
// (não pgmq), então não cabe no FILAS_VIGIADAS do health-check. Este módulo PURO
// decide os alertas a partir de contagens; o health-check só faz as 4 leituras.
//
//   - fila parada: baixa esperando há mais de 30 min com o lançamento LIGADO
//     (worker/cron parado, quarentena longa, canal sumido);
//   - esperando com o lançamento DESLIGADO: as baixas expiram no fim do dia
//     seguinte — alguém precisa decidir (religar ou lançar à mão);
//   - lançamento travado: `lancando` há mais de 20 min (o expirar do worker
//     deveria ter virado `erro` em 15 — o worker não está rodando);
//   - erros: 3+ baixas em `erro` nas últimas 2 h — cada uma é para conferir no
//     SSW e lançar à mão (gestão por exceção: nenhuma baixa some em silêncio).
// =============================================================================

export const FILA_PARADA_MIN = 30;
export const LANCANDO_TRAVADO_ALERTA_MIN = 20;
export const ERROS_JANELA_HORAS = 2;
export const ERROS_LIMITE = 3;

export interface FatosFilaBaixas {
  receberLigado: boolean;
  lancarLigado: boolean;
  /** recebido/na_fila com recebido_em há mais de FILA_PARADA_MIN. */
  esperandoAntigas: number;
  /** lancando com reservado_em há mais de LANCANDO_TRAVADO_ALERTA_MIN. */
  lancandoTravadas: number;
  /** erro com finalizado_em nas últimas ERROS_JANELA_HORAS. */
  errosRecentes: number;
}

export interface AlertaVigia {
  tipo: string;
  chave: string;
  titulo: string;
  detalhes: string;
  payload: Record<string, unknown>;
  cooldown_horas?: number;
}

export function avaliarFilaBaixas(f: FatosFilaBaixas): AlertaVigia[] {
  if (!f.receberLigado) return [];
  const alertas: AlertaVigia[] = [];
  const payload = { ...f };
  if (f.esperandoAntigas > 0 && f.lancarLigado) {
    alertas.push({
      tipo: "fila_baixas_parada",
      chave: "baixas_motorista",
      titulo: `${f.esperandoAntigas} baixa(s) do motorista esperando há mais de ${FILA_PARADA_MIN} min com o lançamento LIGADO`,
      detalhes:
        "A fila da baixa do motorista não anda. Checar, nesta ordem: o pulso do pg_cron (INV-156); o cron " +
        "processar-baixas-motorista (mig 421) e os logs da função; quarentena de login (ultima_categoria = " +
        "'sessao_invalida' nos últimos 30 min — INV-159 d: ESPERAR, não trocar senha); baixa_motorista_config.canal " +
        "preenchido. Antes de drenar uma represa, medir o que ela alimenta (INV-058).",
      payload,
    });
  }
  if (f.esperandoAntigas > 0 && !f.lancarLigado) {
    alertas.push({
      tipo: "baixas_esperando_lancamento_desligado",
      chave: "baixas_motorista",
      titulo: `${f.esperandoAntigas} baixa(s) do motorista esperando: lançamento no SSW DESLIGADO`,
      detalhes:
        "baixa_motorista_lancar_ssw está OFF e as baixas seguem chegando. Elas expiram (erro) no fim do dia seguinte " +
        "ao ocorrido. Decidir: religar o lançamento ou avisar a operação para lançar à mão.",
      payload,
      cooldown_horas: 4,
    });
  }
  if (f.lancandoTravadas > 0) {
    alertas.push({
      tipo: "baixas_lancamento_travado",
      chave: "baixas_motorista",
      titulo: `${f.lancandoTravadas} baixa(s) do motorista presas em 'lancando' há mais de ${LANCANDO_TRAVADO_ALERTA_MIN} min`,
      detalhes:
        "O worker expira lançamento interrompido em 15 min; se ainda está preso, o worker não está rodando. NÃO " +
        "relançar às cegas: conferir no SSW se a ocorrência entrou antes de qualquer ação.",
      payload,
    });
  }
  if (f.errosRecentes >= ERROS_LIMITE) {
    alertas.push({
      tipo: "baixas_em_erro",
      chave: "baixas_motorista",
      titulo: `${f.errosRecentes} baixa(s) do motorista em erro nas últimas ${ERROS_JANELA_HORAS} h`,
      detalhes:
        "Cada baixa em erro precisa ser conferida no SSW e, se faltar, lançada à mão (o Cockpit nunca relança às " +
        "cegas). Ver baixas_motorista.categoria/motivo e o audit_log (idempotency_key 'baixa_motorista:<id>').",
      payload,
    });
  }
  return alertas;
}
