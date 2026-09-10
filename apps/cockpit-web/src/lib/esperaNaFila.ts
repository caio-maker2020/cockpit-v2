// =============================================================================
// Espera na fila — o card mostra HÁ QUANTO TEMPO espera o operador, e não
// "quando um robô encostou nele por último".
//
// RAIZ (Carlos 2026-09-10, NF 350796 / NF 2079912): o rodapé do KanbanCard
// exibia `relativeShort(card.last_event_at ?? card.updated_at)`. O trigger
// `project_card_event` grava `last_event_at = NEW.created_at` pra TODO
// card_event, sem allowlist — e `HistoricoSswPuxado` (refresh interno de cache
// do SSW) sozinho é 13,5% dos eventos em 30 dias, `BastaoCardAtualizado` mais
// 9,8%. Em 27,2% dos cards de "Aguardando você" o relógio exibido era definido
// por ruído de sistema.
//
// Caso-âncora: NF 350796 (CTRC SPL915089-7, oc 19 lançada 26/08 07:03 por
// `alejo`). Na fila desde 26/08 11:00 = 364 h brutas / 109 h úteis — o PIOR
// caso do sistema. Um `HistoricoSswPuxado` em 09/09 20:21 resetou o campo e o
// card se apresentou como "há 17h" em 10/09. O operador leu "chegou agora" e a
// pendência ficou 15 dias invisível na prática.
//
// FONTE ÚNICA: `v_operador_fila_agora` (mig 344) — a MESMA view que a tela de
// Gestão já usa em "Parados há mais de 1 dia útil". Não se recalcula espera
// aqui; só se liga o card na conta que já é a oficial da casa.
//
// FAIL-OPEN por construção: sem linha na view (outras colunas do kanban, card
// fora do escopo, query falhou) o relógio volta a ser `last_event_at` e o card
// renderiza EXATAMENTE como antes. O comportamento novo é aditivo.
// =============================================================================

import type { LinhaFilaAgora } from "./gestaoOperadores";

/** Só o que o card precisa da fila — subconjunto de LinhaFilaAgora. */
export interface EsperaNaFila {
  na_fila_desde: string;
  horas_brutas: number;
  horas_uteis: number;
  parado_mais_1d_util: boolean;
}

/**
 * "fila" = espera real do operador (v_operador_fila_agora).
 * "atividade" = fallback pro comportamento antigo (última escrita no card).
 */
export type OrigemDoRelogio = "fila" | "atividade";

export interface RelogioDoCard {
  /** ISO que alimenta o relativeShort do rodapé. Null = sem dado ("—"). */
  iso: string | null;
  origem: OrigemDoRelogio;
  /** Horas úteis paradas. Só com origem "fila". */
  horasUteis: number | null;
  /** Selo de esquecido. Só com origem "fila". */
  paradoMais1dUtil: boolean;
}

/** O subconjunto de `v_operador_fila_agora` que o board consome. */
export type LinhaFilaParaCard = Pick<
  LinhaFilaAgora,
  "card_id" | "na_fila_desde" | "horas_brutas" | "horas_uteis" | "parado_mais_1d_util"
>;

/** Indexa as linhas da view por card_id. Última linha vence (a view é 1:1). */
export function indexarFilaAgora(
  linhas: ReadonlyArray<LinhaFilaParaCard> | null | undefined,
): Map<string, EsperaNaFila> {
  const m = new Map<string, EsperaNaFila>();
  for (const l of linhas ?? []) {
    if (!l?.card_id || !l.na_fila_desde) continue;
    m.set(l.card_id, {
      na_fila_desde: l.na_fila_desde,
      horas_brutas: Number(l.horas_brutas ?? 0),
      horas_uteis: Number(l.horas_uteis ?? 0),
      parado_mais_1d_util: l.parado_mais_1d_util === true,
    });
  }
  return m;
}

/**
 * Decide o que o rodapé do card exibe.
 *
 * A ORDEM importa: espera na fila SEMPRE ganha de last_event_at. Inverter isso
 * reintroduz o bug da NF 350796 — por isso o teste em esperaNaFila.test.ts trava
 * exatamente este ponto com os números reais de produção.
 */
export function relogioDoCard(
  card: { id: string; last_event_at?: string | null; updated_at?: string | null },
  fila: ReadonlyMap<string, EsperaNaFila> | null | undefined,
): RelogioDoCard {
  return relogioDe(card, fila?.get(card.id));
}

/** Mesma decisão, recebendo a espera já resolvida (é o que o KanbanCard usa). */
export function relogioDe(
  card: { last_event_at?: string | null; updated_at?: string | null },
  espera: EsperaNaFila | null | undefined,
): RelogioDoCard {
  if (espera) {
    return {
      iso: espera.na_fila_desde,
      origem: "fila",
      horasUteis: espera.horas_uteis,
      paradoMais1dUtil: espera.parado_mais_1d_util,
    };
  }
  return {
    iso: card.last_event_at ?? card.updated_at ?? null,
    origem: "atividade",
    horasUteis: null,
    paradoMais1dUtil: false,
  };
}

const DATA_BR = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Sao_Paulo",
});

/**
 * Texto do tooltip. Explica QUAL relógio está na tela — sem isso o operador não
 * tem como distinguir "espera dele" de "última atividade do sistema".
 *
 * As horas úteis vêm da view (calculadas com o now() do banco) e envelhecem com
 * a aba aberta; por isso o número grande do rodapé usa o ISO, que o
 * relativeShort recalcula sempre. Tooltip com minutos de defasagem é aceitável.
 */
export function rotuloRelogio(r: RelogioDoCard): string {
  if (!r.iso) return "Sem data de referência";
  if (r.origem === "atividade") return "Última atividade registrada no card";
  const quando = DATA_BR.format(new Date(r.iso));
  const uteis = r.horasUteis == null ? "" : ` · ${r.horasUteis.toLocaleString("pt-BR")} h úteis parado`;
  return `Na sua fila desde ${quando}${uteis}`;
}
