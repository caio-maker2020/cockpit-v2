// =============================================================================
// oc49-contexto — regras determinísticas do Caio (27/08, caso NF 25021) pra
// decidir a oc 49 ANTES de qualquer heurística ou IA. Ordem obrigatória:
//
//   REGRA A (seguir entrega): no CICLO ATUAL houve 21 ou 55 (cada uma encerra
//   o ciclo), NÃO houve oc 14 (saída pra entrega) depois dela, e vieram
//   ocorrências posteriores (46/49 informativas) → RELANÇAR a mesma 21/55,
//   SEM e-mail (cliente já autorizou; é destravar a operação). O insucesso
//   ANTERIOR à 21/55 já foi tratado — O CICLO TEM PRIORIDADE. A cadeia só
//   quebra se entrar ocorrência DE RELACIONAMENTO no meio (recria o card =
//   ciclo novo); 46 não é de relacionamento e a própria 49 informativa não
//   quebra. Pendência de docs da indenização é IGNORADA aqui — ela volta como
//   59 no pós-entrega (19→59 ou 35→59).
//
//   REGRA B (round-trip indenização): 46 e 49 no MESMO DIA (processo padrão
//   do time de indenização: o caso entrou no indicador deles; só vira análise
//   DE FATO com a oc 33 documentada) e a ocorrência imediatamente anterior ao
//   par é 54 ou 59 → RELANÇAR a mesma 54/59 SEM e-mail (o e-mail já foi).
//   Substitui a automação dormente agente-ressarcimento-relancar-54 (flags
//   OFF desde a criação da 59) e generaliza o caso relancamento_indenizacao.
//
//   NUNCA-MISTURAR (cerca transversal): 46→49 mesmo dia = sinalização de
//   indenização; o TEXTO dessa 49 JAMAIS pode virar "motivo de recusa" ou
//   alimentar rascunho de recusa/devolução (bug da NF 25021: corpo dizia
//   "recusada totalmente... Motivo: DESCRICAO, VALOR E ROMANEIO").
//
// Nem A nem B → null (o chamador segue pros casos existentes e, no fim, IA).
// =============================================================================

import { parseSswDataHoraBrt } from "./ssw-data-hora.ts";

export interface OcTimeline {
  codigo: number | null;
  data: string | null; // formato SSW dd/mm/aa hh:mm
  instrucao: string | null;
}

export type DecisaoContexto49 =
  | { tipo: "relancar_liberacao"; codigo: 21 | 55; dataLiberacao: string | null; textoSsw: string }
  | { tipo: "relancar_pos_indenizacao"; codigo: 54 | 59; dataAnterior: string | null }
  | null;

export const TEXTO_SSW_RELANCAR_21 = "REENTREGA JA LIBERADA";
export const TEXTO_SSW_RELANCAR_55 = "SEGUIR COM A CARGA";

const OC_SAIDA_PRA_ENTREGA = 14;

function ts(o: OcTimeline): number {
  return parseSswDataHoraBrt(o.data) ?? 0;
}

function mesmoDiaSsw(a: string | null, b: string | null): boolean {
  // datas SSW "dd/mm/aa hh:mm" — mesmo dia = mesmos 8 primeiros chars
  if (!a || !b) return false;
  return a.slice(0, 8) === b.slice(0, 8);
}

/** Ordena cronologicamente (asc) — o histórico SSW chega em ordem variável. */
function ordenar(ocorrencias: readonly OcTimeline[]): OcTimeline[] {
  return [...ocorrencias].filter((o) => o.codigo != null).sort((a, b) => ts(a) - ts(b));
}

/** Cerca NUNCA-MISTURAR: a 49 (na data dada) tem uma 46 no MESMO DIA? */
export function ehParDeIndenizacao(
  ocorrencias: readonly OcTimeline[],
  dataDa49: string | null,
): boolean {
  return ocorrencias.some((o) => o.codigo === 46 && mesmoDiaSsw(o.data, dataDa49));
}

export function analisarContextoOc49(
  ocorrencias: readonly OcTimeline[],
  dataDa49: string | null,
  // Injetado pelo caller (fonte única OCORRENCIAS_DE_RELACIONAMENTO de
  // bastao-rules.ts — não importamos aqui porque o módulo tem side-effect de
  // env no top-level e este arquivo é puro/testável).
  ocsRelacionamento: ReadonlySet<number>,
): DecisaoContexto49 {
  const linha = ordenar(ocorrencias);
  const t49 = dataDa49 ? (parseSswDataHoraBrt(dataDa49) ?? Infinity) : Infinity;
  const antesDa49 = linha.filter((o) => ts(o) < t49);

  // ---------------------------------------------------------------------------
  // REGRA A — última 21/55 antes da 49, sem 14 depois, sem oc de RELACIONAMENTO
  // no meio (49 informativa não quebra — Caio 27/08).
  // ---------------------------------------------------------------------------
  let liberacao: OcTimeline | null = null;
  for (const o of antesDa49) if (o.codigo === 21 || o.codigo === 55) liberacao = o;

  if (liberacao) {
    const tLib = ts(liberacao);
    const depoisDaLiberacao = antesDa49.filter((o) => ts(o) > tLib);
    const saiuPraEntrega = depoisDaLiberacao.some((o) => o.codigo === OC_SAIDA_PRA_ENTREGA);
    const quebrouCiclo = depoisDaLiberacao.some(
      (o) =>
        o.codigo !== 49 && // a própria 49 informativa não quebra
        o.codigo != null &&
        ocsRelacionamento.has(o.codigo),
    );
    if (!saiuPraEntrega && !quebrouCiclo) {
      const codigo = liberacao.codigo as 21 | 55;
      return {
        tipo: "relancar_liberacao",
        codigo,
        dataLiberacao: liberacao.data,
        textoSsw: codigo === 21 ? TEXTO_SSW_RELANCAR_21 : TEXTO_SSW_RELANCAR_55,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // REGRA B — 46 no MESMO DIA da 49 + oc imediatamente anterior ao par é 54/59.
  // ---------------------------------------------------------------------------
  if (ehParDeIndenizacao(antesDa49.concat(linha.filter((o) => ts(o) >= t49)), dataDa49)) {
    const foraDoPar = antesDa49.filter(
      (o) => !(o.codigo === 46 && mesmoDiaSsw(o.data, dataDa49)) &&
        !(o.codigo === 49 && mesmoDiaSsw(o.data, dataDa49)),
    );
    const anterior = foraDoPar[foraDoPar.length - 1] ?? null;
    if (anterior && (anterior.codigo === 54 || anterior.codigo === 59)) {
      return {
        tipo: "relancar_pos_indenizacao",
        codigo: anterior.codigo as 54 | 59,
        dataAnterior: anterior.data,
      };
    }
  }

  return null;
}
