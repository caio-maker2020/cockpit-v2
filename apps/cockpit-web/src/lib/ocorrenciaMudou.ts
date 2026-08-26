// =============================================================================
// ocorrenciaMudou — detector PURO do alerta "OCORRÊNCIA MUDOU" (Caio 26/08,
// caso NF 26033: a oc 13 chegou no SSW no meio da tratativa e nada gritou —
// a Isabely só viu porque puxou o histórico na mão).
//
// Compara a última ocorrência REAL do histórico SSW (fresco — o CardDetail
// agora atualiza ao abrir) com a oc que o CARD acha que é a última
// (cod_ultima_ocorrencia, que depende do lag do Bastão). Divergiu → faixa
// vermelha + RE-ANALISAR JÁ.
// =============================================================================

import type { CardRow, HistoricoSswOcorrencia } from "./types";

/** Parse do formato de data do histórico SSW: 'DD/MM/YY HH:MI'. */
export function tsDoHistorico(data: string | null | undefined): number {
  if (!data) return 0;
  const m = /^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/.exec(data.trim());
  if (!m) return 0;
  const [, dd, mm, yy, hh, mi] = m;
  return Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi));
}

/** Última ocorrência COM CÓDIGO do histórico (a mais recente por data). */
export function ultimaOcorrenciaDoHistorico(
  historico: readonly HistoricoSswOcorrencia[] | null | undefined,
): HistoricoSswOcorrencia | null {
  if (!historico?.length) return null;
  let melhor: HistoricoSswOcorrencia | null = null;
  for (const h of historico) {
    if (h.codigo == null) continue;
    if (!melhor || tsDoHistorico(h.data) > tsDoHistorico(melhor.data)) melhor = h;
  }
  return melhor;
}

export interface OcorrenciaMudou {
  ocCard: number;
  ocSsw: number;
  descricaoSsw: string;
  dataSsw: string;
}

/**
 * PURO: o card acha que a última oc é X, mas o histórico SSW (fresco) mostra
 * Y ≠ X e MAIS NOVA que a do card → alerta. Card sem histórico ou sem oc →
 * null (nunca alarme falso por dado ausente).
 */
export function detectarOcorrenciaMudou(
  card: Pick<CardRow, "cod_ultima_ocorrencia" | "historico_ssw"> & {
    bastao_data_ultima_ocorrencia?: string | null;
  },
): OcorrenciaMudou | null {
  const ocCard = card.cod_ultima_ocorrencia;
  if (ocCard == null) return null;
  const ultima = ultimaOcorrenciaDoHistorico(card.historico_ssw);
  if (!ultima || ultima.codigo == null) return null;
  if (ultima.codigo === ocCard) return null;
  return {
    ocCard,
    ocSsw: ultima.codigo,
    descricaoSsw: ultima.descricao ?? "",
    dataSsw: ultima.data ?? "",
  };
}
