// =============================================================================
// reabertura-shadow.ts — PR3 SHADOW (preparado; INERTE por padrão).
//
// Registra a decisão NOVA (`decidirVisibilidadePorSsw`, por identidade) vs a
// ATUAL (caminho per-hora deployado), SEM AGIR sobre o card. Grava 1 linha em
// `reabertura_shadow_log` SÓ quando `shadowEnabled === true` (flag
// `reabertura_shadow_enabled`, default OFF). NUNCA muda decisão. NUNCA lança erro
// (try/catch) — o shadow não pode quebrar o caminho real.
//
// ⚠️ Este módulo NÃO está plugado em sync-bastao nesta rodada (ver relatório PR3
// "onde o shadow seria plugado"). É código preparado, atrás de flag OFF.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  type ArgsVisibilidade,
  decidirVisibilidadePorSsw,
  type DecisaoVisibilidade,
} from "./decidir-visibilidade-ssw.ts";

type SupabaseClient = ReturnType<typeof createClient>;

/** Decisão do caminho ATUAL (per-hora) mapeada p/ 3 valores. */
export type DecisaoAtual = "reabrir" | "suprimir" | "indefinido";

/**
 * A decisão deixa o card VISÍVEL ao operador (AGUARDANDO VOCÊ)? Puro/testável.
 * É o eixo de comparação atual×proposta (o que importa pro bug 346896).
 */
export function operadorVe(d: DecisaoVisibilidade | DecisaoAtual): boolean {
  return d === "MOSTRAR_OPERADOR" || d === "reabrir";
}

/**
 * Desfecho diverge entre atual e proposta? (foco do shadow). Puro/testável.
 * null (sem decisão atual) → não conta como divergência.
 */
export function desfechoDiverge(
  atual: DecisaoAtual | null,
  proposta: DecisaoVisibilidade,
): boolean {
  if (atual == null) return false;
  return operadorVe(atual) !== operadorVe(proposta);
}

export interface ShadowArgs extends ArgsVisibilidade {
  cardId: string;
  nf: string | null;
  caller: "passA" | "sweepInv019" | "passG" | "passH";
  /** Decisão tomada pelo caminho REAL (deployado) neste ciclo. */
  decisaoAtual: DecisaoAtual | null;
}

/**
 * Grava 1 linha de shadow. No-op se `!shadowEnabled`. NUNCA lança (engole o erro)
 * — shadow não pode afetar o caminho real. NÃO age sobre o card.
 *
 * O caller lê a flag UMA vez por sync (evita read por-card) e passa `shadowEnabled`.
 */
export async function registrarShadowReabertura(
  supabase: SupabaseClient,
  shadowEnabled: boolean,
  args: ShadowArgs,
): Promise<void> {
  if (!shadowEnabled) return;
  try {
    const r = decidirVisibilidadePorSsw(args);
    await supabase.from("reabertura_shadow_log").insert({
      card_id: args.cardId,
      nf: args.nf,
      caller: args.caller,
      decisao_atual: args.decisaoAtual,
      decisao_proposta: r.decisao,
      fonte_proposta: r.fonte,
      oc_ssw: r.ocMaisRecente,
      usuario_ssw: r.usuarioMaisRecente,
      indice_ssw: r.indiceMaisRecente,
      indice_lancamento: r.indiceUltimoLancamentoCockpit,
      ssw_fresco: args.sswFresco,
      divergente: desfechoDiverge(args.decisaoAtual, r.decisao),
    });
  } catch (_e) {
    // SHADOW NUNCA QUEBRA O CAMINHO REAL — engole o erro silenciosamente.
  }
}
