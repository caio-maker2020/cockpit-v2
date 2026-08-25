// =============================================================================
// ciclosTratativa — atribui CICLO e ETAPA a cada par sugestão×execução.
//
// Definição VALIDADA pelo Caio (25/08):
//   CICLO = uma PASSAGEM completa do card pelo Cockpit — abre quando o card
//     entra (importado do Bastão / extravio) ou REABRE (Bastão recolocou a NF,
//     reabertura por identidade, reabertura por resposta) e fecha quando sai
//     (TRANSFERIDO/RESOLVIDO). O que reabre depois inicia o ciclo seguinte.
//   ETAPA = cada decisão executada DENTRO da passagem (par do agent_feedback).
// Exemplo do Caio: entrou oc 10 → 54 (etapa 1) → cliente respondeu → 21
// (etapa 2) → TRANSFERIDO = ciclo 1; voltou com 10 → 54 → 44 = ciclo 2.
//
// Identificação nos eventos: ciclo N do par = nº de eventos de ABERTURA com
// timestamp <= o do par. Correção acima de tudo (ordem do Caio): função PURA
// com os casos reais (NFs 234381 e 306070) travados em teste.
// =============================================================================

/** Eventos que ABREM um ciclo (entrada ou reabertura do card). */
export const EVENTOS_ABERTURA_CICLO: ReadonlyArray<string> = [
  "BastaoCardImportado",
  "ExtravioImportado",
  "BastaoReabriuNFFonteRelacionamento",
  "CardReaberto",
  "CardReabertoPorRespostaCliente",
];

export interface PosicaoCiclo {
  ciclo: number;
  totalCiclos: number;
  etapa: number;
  etapasNoCiclo: number;
}

/**
 * PURO: posição do par (timestamp) na história do card.
 * @param aberturasTs timestamps (ms) dos eventos de abertura do card, qualquer ordem.
 * @param paresTs timestamps (ms) de TODOS os pares executados do card (qualquer agente).
 * @param parAlvoTs timestamp (ms) do par cuja posição queremos.
 * Regras de borda: card sem abertura registrada (legado) => ciclo 1/1; par
 * anterior à 1ª abertura (clock skew) => ciclo 1.
 */
export function atribuirCiclo(
  aberturasTs: readonly number[],
  paresTs: readonly number[],
  parAlvoTs: number,
): PosicaoCiclo {
  const aberturas = [...aberturasTs].sort((a, b) => a - b);
  const totalCiclos = Math.max(1, aberturas.length);
  const cicloDe = (t: number): number => {
    let n = 0;
    for (const a of aberturas) { if (a <= t) n++; else break; }
    return Math.max(1, n);
  };
  const ciclo = cicloDe(parAlvoTs);
  const doCiclo = [...paresTs].filter((t) => cicloDe(t) === ciclo).sort((a, b) => a - b);
  const etapasNoCiclo = Math.max(1, doCiclo.length);
  let etapa = doCiclo.findIndex((t) => t === parAlvoTs) + 1;
  if (etapa === 0) etapa = doCiclo.filter((t) => t < parAlvoTs).length + 1; // alvo fora da lista (defensivo)
  return { ciclo, totalCiclos, etapa, etapasNoCiclo };
}

/** Rótulo compacto e inequívoco pro chip da lista. */
export function rotuloCiclo(p: PosicaoCiclo): string {
  return `ciclo ${p.ciclo}/${p.totalCiclos} · etapa ${p.etapa}/${p.etapasNoCiclo}`;
}

// ── Busca (client-side, chunked) das aberturas e pares dos cards de uma lista.
// SEM filtro de período de propósito: etapa/ciclo são da HISTÓRIA INTEIRA do
// card — janela cortada daria numeração errada (ordem do Caio: "precisa ser
// correto"). Chamada só ao abrir a lista (≤ ~200 cards).
import { emBlocos } from "./gestaoOperadores";

export interface HistoricoCiclos {
  aberturas: number[];
  pares: number[];
}

// deno-lint-ignore no-explicit-any
export async function buscarCiclosDosCards(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  cardIds: readonly string[],
): Promise<Map<string, HistoricoCiclos>> {
  const m = new Map<string, HistoricoCiclos>();
  const pega = (id: string) => {
    let cur = m.get(id);
    if (!cur) { cur = { aberturas: [], pares: [] }; m.set(id, cur); }
    return cur;
  };
  // PostgREST corta em 1000 linhas/req (lição INV-088) — cada bloco pagina via
  // range até vir página incompleta, senão a etapa sairia ERRADA em silêncio.
  const paginaTudo = async (montar: (from: number, to: number) => Promise<{ data: unknown; error: unknown }>) => {
    const linhas: Array<{ card_id: string; created_at: string }> = [];
    for (let pg = 0; pg < 20; pg++) {
      const de = pg * 1000;
      const { data, error } = await montar(de, de + 999);
      if (error) throw error;
      const lote = (data ?? []) as Array<{ card_id: string; created_at: string }>;
      linhas.push(...lote);
      if (lote.length < 1000) break;
    }
    return linhas;
  };
  for (const bloco of emBlocos([...cardIds], 100)) {
    const [ev, fb] = await Promise.all([
      paginaTudo((de, ate) =>
        supabase.from("card_events").select("card_id, created_at")
          .in("card_id", bloco).in("event_type", [...EVENTOS_ABERTURA_CICLO])
          .order("created_at").range(de, ate)),
      paginaTudo((de, ate) =>
        supabase.from("agent_feedback").select("card_id, created_at")
          .in("card_id", bloco).in("veredito", ["seguida", "corrigida"])
          .order("created_at").range(de, ate)),
    ]);
    for (const r of ev) pega(r.card_id).aberturas.push(new Date(r.created_at).getTime());
    for (const r of fb) pega(r.card_id).pares.push(new Date(r.created_at).getTime());
  }
  return m;
}

/** Conveniência dos chips: posição do par de um card, ou null se sem histórico. */
export function posicaoDoPar(
  historicos: Map<string, HistoricoCiclos> | undefined,
  cardId: string,
  parTsIso: string,
): PosicaoCiclo | null {
  const h = historicos?.get(cardId);
  if (!h) return null;
  return atribuirCiclo(h.aberturas, h.pares, new Date(parTsIso).getTime());
}
