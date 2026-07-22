// =============================================================================
// guard-anti-loop-criacao.ts — guard anti-loop de fabricação de cards (INV-040).
//
// Caso âncora: NF 2084 (14-15/07/2026) — 74 cards fabricados em rajada, 1 por
// ciclo de sync (~30 min). Mecânica provada no dossiê
// audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md: regressão de roteamento
// (pré-59) fazia o card NASCER terminal (oc 59 → TRANSFERIDO já no INSERT, 30
// cards com evento único BastaoCardImportado) → saía do uniq_cards_nf_active →
// o ciclo seguinte via "NF sem card ativo" e criava outro; a alternância de
// CTRC no Bastão (AMB↔TTO, encerrarCardAntigoSeCtrcMudou) alimentava o loop.
//
// REGRA: antes de CRIAR card pra uma NF, se já existem >= LIMITE cards
// TERMINAIS dessa NF criados nas últimas 24h → NÃO cria; loga + card_event
// LoopCriacaoCardDetectado no card mais recente da NF (dedupe: 1 evento por
// NF/24h pra não poluir o event stream enquanto a pendência persistir).
//
// Por que isso ataca a RAIZ da CLASSE (e não o sintoma): o UNIQUE parcial é
// proposital (re-ocorrência legítima cria card novo) e NÃO protege contra
// criação→terminal→recriação. QUALQUER regressão futura de roteamento que
// gere terminais no nascimento reabriria o loop; o guard limita a fabricação
// independente de qual regressão a cause. Re-ocorrência legítima não é
// afetada: NF normal não acumula 3 cards terminais criados em 24h.
//
// Fail-open: erro de banco DENTRO do guard nunca bloqueia o sync nem a
// criação (loga e deixa criar) — sync-bastao é a função mais crítica do
// sistema e o guard não pode virar ponto único de falha.
// =============================================================================

// deno-lint-ignore-file no-explicit-any
type SupabaseClient = any;

/** Máximo de cards TERMINAIS da mesma NF criados em 24h antes de bloquear a criação. */
export const LIMITE_TERMINAIS_24H = 3;

/** Mesmo conjunto terminal do uniq_cards_nf_active (estados fora do UNIQUE parcial). */
export const STATES_TERMINAIS_CARDS = ["RESOLVIDO", "CANCELADO", "TRANSFERIDO"] as const;

export const EVENTO_LOOP_DETECTADO = "LoopCriacaoCardDetectado";

/** Decisão pura (testável): bloqueia quando qtd de terminais em 24h atinge o limite. */
export function excedeuLimiteLoopCriacao(
  qtdTerminais24h: number,
  limite: number = LIMITE_TERMINAIS_24H,
): boolean {
  return Number.isFinite(qtdTerminais24h) && qtdTerminais24h >= limite;
}

export function montarPayloadLoopDetectado(args: {
  nf: string;
  origem: "bastao" | "extravio";
  ctrc: string | null;
  qtdTerminais24h: number;
  limite: number;
}): Record<string, unknown> {
  return {
    nf: args.nf,
    origem: args.origem,
    ctrc_pendencia: args.ctrc,
    qtd_terminais_24h: args.qtdTerminais24h,
    limite: args.limite,
    motivo:
      `Guard anti-loop (INV-040): ${args.qtdTerminais24h} cards TERMINAIS da NF ` +
      `criados nas últimas 24h (limite ${args.limite}). Criação bloqueada — padrão ` +
      "de fabricação em rajada (caso âncora NF 2084, 74 cards em 14-15/07/2026). " +
      "Loop criação→terminal→recriação: o uniq_cards_nf_active (parcial, proposital) " +
      "não segura card que nasce/vira terminal no mesmo ciclo.",
  };
}

/**
 * Retorna true se a criação do card deve ser BLOQUEADA (loop detectado).
 * Nunca lança; qualquer erro interno → false (fail-open, criação segue).
 */
export async function bloquearCriacaoSeLoopDetectado(
  supabase: SupabaseClient,
  args: { nf: string; origem: "bastao" | "extravio"; ctrc?: string | null },
): Promise<boolean> {
  try {
    const desde = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

    const { count, error: cntErr } = await supabase
      .from("cards")
      .select("id", { count: "exact", head: true })
      .eq("nf", args.nf)
      .in("state", [...STATES_TERMINAIS_CARDS])
      .gte("created_at", desde);
    if (cntErr) {
      console.error(`[guard-anti-loop] NF ${args.nf}: erro no count (fail-open): ${cntErr.message}`);
      return false;
    }
    const qtd = count ?? 0;
    if (!excedeuLimiteLoopCriacao(qtd)) return false;

    console.error(
      `[guard-anti-loop] NF ${args.nf} (${args.origem}): ${qtd} cards terminais criados em 24h ` +
        `(limite ${LIMITE_TERMINAIS_24H}) — criação BLOQUEADA (INV-040, caso âncora NF 2084).`,
    );

    // Dedupe do evento de anomalia: 1 por NF a cada 24h (o sync roda a cada
    // ~30 min; sem dedupe seriam ~48 eventos/dia enquanto a pendência durar).
    const { count: jaEmitido, error: dedupeErr } = await supabase
      .from("card_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", EVENTO_LOOP_DETECTADO)
      .eq("payload->>nf", args.nf)
      .gte("created_at", desde);
    if (!dedupeErr && (jaEmitido ?? 0) > 0) return true;

    const { data: cardRecente } = await supabase
      .from("cards")
      .select("id")
      .eq("nf", args.nf)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cardRecente?.id) {
      await supabase.from("card_events").insert({
        card_id: cardRecente.id,
        event_type: EVENTO_LOOP_DETECTADO,
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: montarPayloadLoopDetectado({
          nf: args.nf,
          origem: args.origem,
          ctrc: args.ctrc ?? null,
          qtdTerminais24h: qtd,
          limite: LIMITE_TERMINAIS_24H,
        }),
      });
    }
    return true;
  } catch (e) {
    console.error(`[guard-anti-loop] NF ${args.nf}: erro inesperado (fail-open): ${e}`);
    return false;
  }
}
