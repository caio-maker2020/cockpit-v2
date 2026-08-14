// =============================================================================
// wurth-ciclo — guard de CICLO do retorno da intranet Würth (Caio 2026-08-14).
//
// PROBLEMA REAL (NF 677750, Würth/Ingrid):
//   11/08 17:02  oc 13  entrega impossibilitada  → NÃO vira tratativa (Würth não
//                                                  tem exceção de oc 13)
//   12/08 08:39  Würth responde na intranet: "Reentrega — REENTREGAR EM HORÁRIO
//                COMERCIAL, BERENICE"   ← resposta da oc 13, ciclo ANTERIOR
//   12/08 23:26  oc 10  RECUSA TOTAL     ← ISTO gerou o card no Cockpit
//   13/08 10:42  oc 54  (Ingrid formaliza + e-mail)
//   13/08 19:00  robô lê a linha de 12/08 08:39 e sugere oc 21 RECOMENDADA
//                — reentrega que a Würth NUNCA autorizou pra este ciclo.
//
// A intranet Würth responde por NF, não por ciclo. Uma NF tem vários ciclos
// (recusa → reentrega → nova recusa; extravio → parcial → recusa...), e a
// consulta "Solucionado Würth" devolve a linha do ciclo antigo do mesmo jeito.
//
// REGRA (Caio 2026-08-14): a `Data Solução` da Würth precisa ser POSTERIOR
// (com hora) à data/hora da ocorrência SAL que gerou o input no Cockpit. Se for
// anterior, o retorno é de outro ciclo e deve ser DESCARTADO.
//
// Por que a âncora é a ocorrência-gatilho (oc 10) e NÃO a oc 54:
//   existe integração EDI SAL → Würth; a Würth recebe a ocorrência quase na
//   mesma hora em que o motorista lança. A 54 é só a formalização da operadora
//   (evidência + rastreabilidade) e vem DEPOIS — ancorar nela descartaria
//   retornos legítimos que a Würth deu entre a ocorrência real e a 54.
//
// Módulo PURO (sem fetch/DB) pra ser testável. Integração: robo-intranet-wurth.
// =============================================================================

import { parseSswDataHoraBrt } from "./ssw-data-hora.ts";

/** Ocorrências que o próprio Cockpit lança (formalização/tratativa) — nunca são
 *  a âncora do ciclo. */
export const OCS_LANCADAS_PELA_TRATATIVA: ReadonlySet<number> = new Set([
  21, 33, 44, 54, 55, 56, 59,
]);

/** Ocorrências que ABREM um ciclo de relacionamento (viram input no Cockpit).
 *  Espelha `ocorrencias_dicionario` (responsabilidade='Relacionamento') + oc 13,
 *  que é gatilho pros clientes com exceção. Sem 54/59 (responsabilidade Cliente).
 *  O caller pode injetar o Set do dicionário via `opts.ocsGatilho`. */
export const OCS_GATILHO_PADRAO: ReadonlySet<number> = new Set([
  3, 8, 10, 11, 13, 17, 19, 20, 23, 26, 28, 35, 43, 49, 57,
]);

export interface OcorrenciaSswHistorico {
  /** "DD/MM/YY HH:MM" (BRT), como o SSW serve. */
  data?: string | null;
  codigo?: number | null;
}

export interface GatilhoCiclo {
  /** epoch ms UTC da ocorrência que gerou o input; null = indeterminado. */
  ts: number | null;
  /** false quando só temos o DIA (fallback Bastão, sem hora). */
  temHora: boolean;
  codigo: number | null;
  fonte: "historico_ssw" | "bastao_dia" | "indeterminado";
  detalhe: string;
}

export interface CardParaGatilho {
  historicoSsw?: OcorrenciaSswHistorico[] | null;
  /** snapshot da oc do Bastão no momento em que a operadora agiu. */
  bastaoOcNoLancamento?: number | null;
  codUltimaOcorrencia?: number | null;
  /** "YYYY-MM-DD" do Bastão — SEM hora (por isso é só fallback). */
  dataUltimaOcorrencia?: string | null;
}

/**
 * Descobre a data/hora da ocorrência SAL que gerou a tratativa (a âncora do
 * ciclo). Ordem de preferência:
 *   1. histórico SSW, entrada mais recente do código-gatilho do card
 *      (`bastao_oc_no_lancamento` ?? `cod_ultima_ocorrencia`) — tem HORA;
 *   2. histórico SSW, ocorrência de gatilho mais recente (usado quando o código
 *      do card já virou 54/59 ou não aparece no histórico);
 *   3. data do Bastão (só o DIA — guard degradado, não pega caso do mesmo dia);
 *   4. indeterminado → guard NÃO se aplica (nunca descarta no escuro).
 */
export function resolverGatilhoCiclo(
  card: CardParaGatilho,
  opts?: { ocsGatilho?: ReadonlySet<number>; ocsNossas?: ReadonlySet<number> },
): GatilhoCiclo {
  const ocsGatilho = opts?.ocsGatilho ?? OCS_GATILHO_PADRAO;
  const ocsNossas = opts?.ocsNossas ?? OCS_LANCADAS_PELA_TRATATIVA;

  const hist = (card.historicoSsw ?? [])
    .map((o) => ({ codigo: typeof o?.codigo === "number" ? o.codigo : null, ts: parseSswDataHoraBrt(o?.data) }))
    .filter((o): o is { codigo: number | null; ts: number } => o.ts != null);

  const maisRecente = (filtro: (c: number | null) => boolean) =>
    hist.filter((o) => filtro(o.codigo)).sort((a, b) => b.ts - a.ts)[0] ?? null;

  const codigoAlvo = card.bastaoOcNoLancamento ?? card.codUltimaOcorrencia ?? null;

  if (codigoAlvo != null && !ocsNossas.has(codigoAlvo)) {
    const achado = maisRecente((c) => c === codigoAlvo);
    if (achado) {
      return {
        ts: achado.ts,
        temHora: true,
        codigo: codigoAlvo,
        fonte: "historico_ssw",
        detalhe: `oc ${codigoAlvo} do card no histórico SSW`,
      };
    }
  }

  const gatilho = maisRecente((c) => c != null && ocsGatilho.has(c));
  if (gatilho) {
    return {
      ts: gatilho.ts,
      temHora: true,
      codigo: gatilho.codigo,
      fonte: "historico_ssw",
      detalhe: `ocorrência de gatilho mais recente no histórico SSW (oc ${gatilho.codigo})`,
    };
  }

  const dia = parseDiaIso(card.dataUltimaOcorrencia);
  if (dia != null) {
    return {
      ts: dia,
      temHora: false,
      codigo: codigoAlvo,
      fonte: "bastao_dia",
      detalhe: "data do Bastão (sem hora) — comparação degradada por DIA",
    };
  }

  return { ts: null, temHora: false, codigo: codigoAlvo, fonte: "indeterminado", detalhe: "sem histórico SSW e sem data do Bastão" };
}

export interface InstanteWurth {
  ts: number;
  temHora: boolean;
}

/**
 * Parseia a `Data Solução` da intranet Würth. Formato real (26 amostras em
 * produção): "YYYY-MM-DD HH:MM", horário de Brasília. Tolera "DD/MM/YYYY HH:MM",
 * "DD/MM/YY HH:MM" e as três variantes sem hora (`temHora: false`).
 */
export function parseDataSolucaoWurth(s: string | null | undefined): InstanteWurth | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (iso) return monta(Number(iso[1]), Number(iso[2]), Number(iso[3]), iso[4], iso[5]);
  // \d{4} ANTES de \d{2}: a alternância é preguiçosa e "2026" casaria como "20".
  const br = t.match(/^(\d{2})\/(\d{2})\/(\d{4}|\d{2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (br) {
    const ano = br[3]!.length === 2 ? 2000 + Number(br[3]) : Number(br[3]);
    return monta(ano, Number(br[2]), Number(br[1]), br[4], br[5]);
  }
  return null;
}

function monta(ano: number, mes: number, dia: number, hh?: string, mi?: string): InstanteWurth {
  const temHora = hh != null && mi != null;
  // BRT (-03) → UTC: soma 3h (mesma convenção do parser do SSW).
  return {
    ts: Date.UTC(ano, mes - 1, dia, (temHora ? Number(hh) : 0) + 3, temHora ? Number(mi) : 0),
    temHora,
  };
}

function parseDiaIso(s: string | null | undefined): number | null {
  const m = (s ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 3, 0); // 00:00 BRT
}

/** YYYYMMDD do instante em BRT — usado na comparação degradada por dia. */
function diaBrt(ts: number): number {
  const d = new Date(ts - 3 * 60 * 60 * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export interface VeredictoCiclo {
  descartar: boolean;
  motivo: string;
  precisao: "hora" | "dia" | "indeterminado";
  data_solucao_ts: string | null;
  gatilho_ts: string | null;
}

/**
 * Aplica a regra: retorno da Würth ANTERIOR à ocorrência que gerou o input é de
 * ciclo antigo → descartar. Fail-open por construção: sem âncora confiável ou
 * com data ilegível, NÃO descarta (o guard nunca cega o robô no escuro; o motivo
 * fica registrado no card_event pra auditoria).
 */
export function avaliarCicloRetornoWurth(
  dataSolucao: string | null | undefined,
  gatilho: GatilhoCiclo,
): VeredictoCiclo {
  const sol = parseDataSolucaoWurth(dataSolucao);
  const base = {
    data_solucao_ts: sol ? new Date(sol.ts).toISOString() : null,
    gatilho_ts: gatilho.ts != null ? new Date(gatilho.ts).toISOString() : null,
  };
  if (!sol) {
    return { descartar: false, motivo: `Data Solução ilegível ("${dataSolucao ?? ""}") — guard não aplicado`, precisao: "indeterminado", ...base };
  }
  if (gatilho.ts == null) {
    return { descartar: false, motivo: `ocorrência-gatilho indeterminada (${gatilho.detalhe}) — guard não aplicado`, precisao: "indeterminado", ...base };
  }

  if (sol.temHora && gatilho.temHora) {
    const descartar = sol.ts < gatilho.ts;
    return {
      descartar,
      motivo: descartar
        ? `Data Solução (${fmt(sol.ts)}) anterior à oc ${gatilho.codigo ?? "?"} que gerou a tratativa (${fmt(gatilho.ts)}) — retorno de ciclo anterior`
        : `Data Solução (${fmt(sol.ts)}) posterior à oc ${gatilho.codigo ?? "?"} (${fmt(gatilho.ts)}) — retorno do ciclo corrente`,
      precisao: "hora",
      ...base,
    };
  }

  const descartar = diaBrt(sol.ts) < diaBrt(gatilho.ts);
  return {
    descartar,
    motivo: descartar
      ? `Data Solução (${fmt(sol.ts)}) é de dia anterior à oc ${gatilho.codigo ?? "?"} (${fmt(gatilho.ts)}) — retorno de ciclo anterior (comparação por DIA)`
      : `sem hora nos dois lados — comparação por DIA não reprova (${fmt(sol.ts)} vs ${fmt(gatilho.ts)})`,
    precisao: "dia",
    ...base,
  };
}

function fmt(ts: number): string {
  const d = new Date(ts - 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} BRT`;
}
