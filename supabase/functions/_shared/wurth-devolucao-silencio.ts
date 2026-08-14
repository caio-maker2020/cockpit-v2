// =============================================================================
// wurth-devolucao-silencio.ts — R1 da devolução Würth (Caio 2026-08-14).
//
// REGRA: oc 11 (problema com endereço) → Ingrid notifica (54 + e-mail + a oc
// já sobe pra intranet via EDI). Se a Würth NÃO retorna NADA em 10 dias
// corridos — nem e-mail, nem intranet — a devolução está autorizada por
// processo: o robô SUGERE oc 44 (recomendada) com EVIDÊNCIA do silêncio e a
// operadora aprova. Nunca autônomo.
//
// Âncoras (decididas com o Caio):
//  - Os 10 dias contam da DATA/HORA DA 54 (a notificação formal). Sem 54
//    lançada, a regra NÃO arma.
//  - Gatilho do ciclo = oc 11 via resolverGatilhoCiclo (mesma âncora do guard
//    de ciclo em produção). Retorno da intranet de ciclo ANTERIOR não conta
//    como retorno — avaliarCicloRetornoWurth já dá esse veredicto.
//  - Silêncio por e-mail = cliente_respondeu_em nulo OU anterior à 54.
//
// Módulo PURO (sem fetch/DB) — o robô (robo-intranet-wurth) orquestra.
// =============================================================================

import { parseSswDataHoraBrt } from "./ssw-data-hora.ts";
import {
  avaliarCicloRetornoWurth,
  resolverGatilhoCiclo,
  type GatilhoCiclo,
  type OcorrenciaSswHistorico,
} from "./wurth-ciclo.ts";
import type { LinhaRetornoWurth } from "./wurth-intranet.ts";

export const DIAS_SILENCIO_PARA_DEVOLUCAO = 10;
const DIA_MS = 24 * 60 * 60 * 1000;

export interface CardParaSilencio {
  historicoSsw?: OcorrenciaSswHistorico[] | null;
  bastaoOcNoLancamento?: number | null;
  codUltimaOcorrencia?: number | null;
  dataUltimaOcorrencia?: string | null;
  /** cards.cliente_respondeu_em (ISO) — resposta por e-mail. */
  clienteRespondeuEm?: string | null;
}

export type VeredictoSilencio =
  | {
    sugerir: true;
    gatilho: GatilhoCiclo;
    /** epoch ms da 54 que abriu a contagem. */
    data54Ts: number;
    diasSemRetorno: number;
    /** linhas da NF na intranet que existem mas são de ciclo anterior. */
    linhasCicloAnterior: LinhaRetornoWurth[];
    motivo: string;
  }
  | { sugerir: false; motivo: string };

/**
 * Timestamp da oc 54 POSTERIOR ao gatilho (a notificação formal deste ciclo).
 * 54 anterior ao gatilho é de outro ciclo — não conta.
 */
export function acharData54DoCiclo(
  historico: OcorrenciaSswHistorico[] | null | undefined,
  gatilhoTs: number,
): number | null {
  let melhor: number | null = null;
  for (const o of historico ?? []) {
    if (o?.codigo !== 54) continue;
    const ts = parseSswDataHoraBrt(o?.data);
    if (ts == null || ts < gatilhoTs) continue;
    // a PRIMEIRA 54 pós-gatilho abre a contagem (re-lançamentos não resetam o prazo)
    if (melhor == null || ts < melhor) melhor = ts;
  }
  return melhor;
}

/**
 * Decide se o card cruzou os 10 dias de silêncio total (R1).
 *
 * `linhasDaNfNaIntranet` = TODAS as linhas da consulta desta NF (o robô já tem
 * a consulta em mãos). Linha com Data Solução posterior ao gatilho = retorno
 * REAL → não sugere. Linha de ciclo anterior vira parte da evidência.
 *
 * Fail-closed por desenho: qualquer âncora indeterminada (sem gatilho com hora,
 * sem 54, histórico ausente) → NÃO sugere. Diferente do guard de ciclo
 * (fail-open), aqui a ação é ATIVA (move card, sugere devolução) — na dúvida,
 * não age.
 */
export function avaliarSilencioParaDevolucao(
  card: CardParaSilencio,
  linhasDaNfNaIntranet: LinhaRetornoWurth[],
  agoraMs: number,
): VeredictoSilencio {
  const gatilho = resolverGatilhoCiclo({
    historicoSsw: card.historicoSsw,
    bastaoOcNoLancamento: card.bastaoOcNoLancamento,
    codUltimaOcorrencia: card.codUltimaOcorrencia,
    dataUltimaOcorrencia: card.dataUltimaOcorrencia,
  });

  if (gatilho.ts == null || !gatilho.temHora || gatilho.fonte !== "historico_ssw") {
    return { sugerir: false, motivo: `gatilho do ciclo indeterminado (${gatilho.detalhe}) — R1 exige histórico SSW` };
  }
  if (gatilho.codigo !== 11) {
    return { sugerir: false, motivo: `gatilho do ciclo é oc ${gatilho.codigo ?? "?"} (R1 só vale pra oc 11)` };
  }

  const data54Ts = acharData54DoCiclo(card.historicoSsw, gatilho.ts);
  if (data54Ts == null) {
    return { sugerir: false, motivo: "sem oc 54 lançada após a oc 11 — notificação formal ainda não aconteceu, regra não arma" };
  }

  const diasSemRetorno = Math.floor((agoraMs - data54Ts) / DIA_MS);
  if (diasSemRetorno < DIAS_SILENCIO_PARA_DEVOLUCAO) {
    return { sugerir: false, motivo: `apenas ${diasSemRetorno} dia(s) desde a 54 — aguarda ${DIAS_SILENCIO_PARA_DEVOLUCAO}` };
  }

  // Silêncio por e-mail: resposta registrada DEPOIS da 54 = teve retorno.
  const respondeuEm = card.clienteRespondeuEm ? Date.parse(card.clienteRespondeuEm) : null;
  if (respondeuEm != null && !Number.isNaN(respondeuEm) && respondeuEm >= data54Ts) {
    return { sugerir: false, motivo: "cliente respondeu por e-mail depois da 54 — não é silêncio" };
  }

  // Silêncio na intranet: linha com Data Solução posterior ao GATILHO = retorno
  // do ciclo corrente. Linha anterior = ciclo velho (vira evidência, não retorno).
  const linhasCicloAnterior: LinhaRetornoWurth[] = [];
  for (const linha of linhasDaNfNaIntranet) {
    const v = avaliarCicloRetornoWurth(linha.dataSolucao, gatilho);
    if (v.precisao === "indeterminado") {
      // data ilegível → não dá pra afirmar silêncio; na dúvida, não age.
      return { sugerir: false, motivo: `linha da intranet com Data Solução ilegível ("${linha.dataSolucao}") — silêncio não comprovável` };
    }
    if (!v.descartar) {
      return { sugerir: false, motivo: `há retorno da Würth na intranet (${linha.dataSolucao} · ${linha.solucao}) — não é silêncio` };
    }
    linhasCicloAnterior.push(linha);
  }

  return {
    sugerir: true,
    gatilho,
    data54Ts,
    diasSemRetorno,
    linhasCicloAnterior,
    motivo:
      `${diasSemRetorno} dias corridos sem NENHUM retorno da Würth (e-mail e intranet) ` +
      `desde a 54 de ${fmtBrt(data54Ts)} (oc 11 de ${fmtBrt(gatilho.ts)}) — devolução autorizada por processo`,
  };
}

function fmtBrt(ts: number): string {
  const d = new Date(ts - 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} BRT`;
}
