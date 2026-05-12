// =============================================================================
// safe-oc-update — Camada 2 do plano "invariante NF de relacionamento".
//
// Função: clampOcAoDicionario(...) — gateway obrigatório pra qualquer write em
// cards.cod_ultima_ocorrencia vindo de fonte externa (Bastão, SSW tracking,
// SSW interno, executor). Se a oc não existe em ocorrencias_dicionario,
// preserva a anterior + grava evento OcorrenciaForaDoDicionarioIgnorada.
//
// Motivo: a FK cards_cod_ultima_ocorrencia_fkey só protege depois do UPDATE
// estourar (= upsert abortado, card travado, erro silencioso em errors[]).
// Esse helper previne ANTES: a oc inválida nunca chega ao DB e a invariante
// "NF de relacionamento no Cockpit" não é violada por causa de um valor
// fora do dicionário.
// =============================================================================

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

// Cache por invocação (Deno re-inicializa entre invocações da edge function).
let _cachedOcsValidas: Set<number> | null = null;

export async function loadOcsValidasDoDicionario(
  supabase: SupabaseClient,
): Promise<Set<number>> {
  if (_cachedOcsValidas) return _cachedOcsValidas;
  const { data, error } = await supabase
    .from("ocorrencias_dicionario")
    .select("codigo");
  if (error) {
    throw new Error(`safe-oc-update: load ocorrencias_dicionario: ${error.message}`);
  }
  _cachedOcsValidas = new Set((data ?? []).map((r) => (r as { codigo: number }).codigo));
  return _cachedOcsValidas;
}

/**
 * Retorna a oc se válida no dicionário, senão preserva ocAnterior.
 * Se descartar a oc, grava card_events.OcorrenciaForaDoDicionarioIgnorada
 * (se cardId fornecido) pra auditoria.
 *
 * Uso recomendado: em TODO ponto que escreve cards.cod_ultima_ocorrencia
 * com valor vindo de fonte externa (Bastão pendencia, tracking SSW,
 * scraping interno, executor).
 *
 * @param contexto string curta identificando o caller (ex: "sync-bastao/passA",
 *                 "executor/pos-lancamento", "vinculador/criacao-card")
 */
export async function clampOcAoDicionario(
  supabase: SupabaseClient,
  oc: number | null | undefined,
  ocAnterior: number | null,
  contexto: string,
  cardId?: string | null,
): Promise<number | null> {
  if (oc == null) return ocAnterior;

  const ocs = await loadOcsValidasDoDicionario(supabase);
  if (ocs.has(oc)) return oc;

  console.warn(
    `[safe-oc] oc=${oc} fora do dicionário (contexto=${contexto}), mantendo oc=${ocAnterior}`,
  );

  if (cardId) {
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "OcorrenciaForaDoDicionarioIgnorada",
      actor_type: "system",
      actor_id: "safe-oc-update",
      payload: {
        oc_invalida: oc,
        oc_mantida: ocAnterior,
        contexto,
      },
    });
  }

  return ocAnterior;
}
