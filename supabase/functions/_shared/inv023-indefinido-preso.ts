// =============================================================================
// inv023-indefinido-preso.ts — decisão pura do monitor "card invisível preso
// em INDEFINIDO_RETRY" (INV-023, health-check).
//
// Bug âncora NF 371705 / card 076b318a (Caio 2026-08-07): o monitor só
// reconhecia 4 eventos como "saída do indefinido". O card saiu do limbo por um
// 5º caminho — SWEEP INV-019 (`AguardandoClienteOcMudou`) → operadora aprovou
// → oc 56 lançada e confirmada → Bastão transferiu. Pro monitor, o último
// evento "de visibilidade" seguia sendo o `ReaberturaIndefinida` de 16:31 BRT
// (aberto durante a pane l.silva), então ele re-disparou o MESMO alerta de
// hora em hora (13 emails em 13h) pra um card já tratado — alerta zumbi.
//
// Raiz: o monitor rastreava a ENTRADA no indefinido sem conhecer todas as
// SAÍDAS. Regra daqui em diante: TODO evento que prova que a visibilidade foi
// re-decidida ou que o estado do card transitou DEPOIS do limbo encerra o
// alerta. Ao criar um caminho novo de saída do INDEFINIDO_RETRY, adicione o
// evento em EVENTOS_SAIDA_INDEFINIDO — o teste ancora o cenário real.
// =============================================================================

/** Evento que marca a ENTRADA do card no limbo de visibilidade. */
export const EVENTO_ENTRADA_INDEFINIDO = "ReaberturaIndefinida";

/**
 * Eventos que provam que o card SAIU do limbo (visibilidade re-decidida ou
 * estado transitou). Se qualquer um deles for mais recente que o
 * `ReaberturaIndefinida`, o card NÃO está preso.
 */
export const EVENTOS_SAIDA_INDEFINIDO = [
  // — os 4 originais do monitor —
  "ReaberturaPorIndefinidoExpirado", // política de prazo escalou pra MOSTRAR
  "CardReaberto",                    // reabertura explícita
  "ReaberturaSuprimidaPorVerdadeSsw",// verdade do SSW decidiu manter fora
  "DevolvidoParaSetor",              // devolvido — visibilidade re-decidida
  // — saídas que faltavam (NF 371705, 2026-08-07) —
  "AguardandoClienteOcMudou",        // SWEEP INV-019 → AGUARDANDO VOCÊ (visível)
  "StateTransicaoPosSucesso",        // executor pós-lançamento aprovado
  "AcaoExecutadaConfirmadaPeloSsw",  // SSW confirmou ação nossa → destino final
  "ExecucaoReconciliada",            // watchdog re-enfileirou e resolveu
  "StateForcadoOc54AguardandoCliente", // regra oc=54 ⟺ AGUARDANDO_CLIENTE
  "AcaoRevertidaPosFalha",           // revert → AGUARDANDO VOCÊ (visível)
] as const;

/** Lista completa pra buscar em card_events (entrada + saídas). */
export const EVENTOS_MONITOR_INDEFINIDO: string[] = [
  EVENTO_ENTRADA_INDEFINIDO,
  ...EVENTOS_SAIDA_INDEFINIDO,
];

export interface EventoVisibilidade {
  card_id: string;
  event_type: string;
  created_at: string;
}

export interface IndefinidoPreso {
  card_id: string;
  indefinido_desde: string;
}

/**
 * Decide quais cards estão PRESOS em INDEFINIDO_RETRY.
 *
 * Preso = o evento mais recente do card (dentre entrada+saídas) é
 * `ReaberturaIndefinida` E ele tem mais de `thresholdMin` minutos.
 * Eventos devem vir ordenados do MAIS RECENTE pro mais antigo (como o
 * health-check já busca: `.order("created_at", { ascending: false })`).
 */
export function acharIndefinidosPresos(
  eventos: EventoVisibilidade[],
  agoraMs: number,
  thresholdMin: number,
): IndefinidoPreso[] {
  const ultimo = new Map<string, EventoVisibilidade>();
  for (const e of eventos) {
    if (!ultimo.has(e.card_id)) ultimo.set(e.card_id, e);
  }
  const cutoff = agoraMs - thresholdMin * 60 * 1000;
  const presos: IndefinidoPreso[] = [];
  for (const [cardId, e] of ultimo) {
    if (
      e.event_type === EVENTO_ENTRADA_INDEFINIDO &&
      new Date(e.created_at).getTime() < cutoff
    ) {
      presos.push({ card_id: cardId, indefinido_desde: e.created_at });
    }
  }
  return presos;
}
