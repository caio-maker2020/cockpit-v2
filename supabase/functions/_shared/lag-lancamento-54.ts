// =============================================================================
// lag-lancamento-54.ts — discriminador ROBUSTO entre "oc do Bastão é a ANTERIOR
// lagando após o Cockpit lançar 54" (NÃO rebaixar) vs "oc genuinamente NOVA pós-54".
//
// Caio 2026-06-24 (REGRESSÃO NF 175621 + 10415): o operador lançou oc=54 pelo
// Cockpit → card foi pra AGUARDANDO_CLIENTE. O Bastão (RPA atrasado) seguiu
// mostrando a oc ANTERIOR (49, datada de ANTES do lançamento). O Pass A/sweep do
// INV-019 acharam "oc de relacionamento ≠54" e rebaixaram pra AGUARDANDO VOCÊ →
// RETRABALHO. Guards antigos falharam: `acao_executada_em` é LIMPO pra null pelo
// confirmar-acao-executada-ssw ao ir pra AGUARDANDO_CLIENTE; `bastao_oc_no_lancamento`
// é inconsistente (null em vários cards).
//
// DISCRIMINADOR CORRETO = DATA. A oc do Bastão só é "nova" se for MAIS RECENTE que
// o último lançamento de 54 bem-sucedido do Cockpit (acoes_executadas_ssw). Se a
// data da oc do Bastão for <= a data de um lançamento de 54, é a oc ANTERIOR
// lagando → NUNCA rebaixar (regra do Caio: "54 lançada pelo Cockpit ⇒ a anterior
// não rebaixa"). Fonte autoritativa = o próprio registro de lançamento do Cockpit,
// não o Bastão (que mente por atraso) nem campos voláteis do card.
//
// Conservador: `<=` (mesmo dia também conta como lag) — erra pro lado de NÃO
// rebaixar (zero retrabalho), que é a prioridade explícita do Caio.
// =============================================================================

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

/**
 * Parte PURA (testável): a oc do Bastão é lag de um lançamento de 54?
 * @param bastaoOcDateBrt  data da oc do Bastão, 'YYYY-MM-DD' (bastao_data_ultima_ocorrencia).
 * @param ultimoLanc54DateBrt  data BRT do último lançamento de 54 bem-sucedido, ou null.
 * @returns true = é lag da anterior → NÃO rebaixar. false = oc nova/sem lançamento → pode avaliar.
 */
export function ehLagDeLancamento54PorData(
  bastaoOcDateBrt: string | null,
  ultimoLanc54DateBrt: string | null,
): boolean {
  if (!ultimoLanc54DateBrt) return false; // Cockpit nunca lançou 54 → não é lag de 54.
  if (!bastaoOcDateBrt) return true; // sem data do Bastão mas teve 54 lançada → conservador: não rebaixa.
  return bastaoOcDateBrt <= ultimoLanc54DateBrt;
}

export type ClasseRebaixa = "lag" | "nova" | "ambiguo";

/**
 * Classifica (PURO) a oc do Bastão vs o lançamento de 54, por DATA:
 *   - "lag"     → data da oc do Bastão é ANTES do lançamento → é a anterior atrasada → FICA (sem SSW).
 *   - "nova"    → data da oc do Bastão é DEPOIS do lançamento → oc nova → MOVE (sem SSW).
 *   - "ambiguo" → MESMO DIA → a data não desempata (a anterior e o lançamento caíram
 *                 no mesmo dia) → precisa de 1 consulta SSW pra saber a verdade.
 * Sem lançamento de 54 → "nova" (deixa o fluxo normal decidir; não é caso de lag de 54).
 */
export function classificarPorData(
  bastaoOcDateBrt: string | null,
  ultimoLanc54DateBrt: string | null,
): ClasseRebaixa {
  if (!ultimoLanc54DateBrt) return "nova";
  if (!bastaoOcDateBrt) return "lag"; // conservador
  if (bastaoOcDateBrt < ultimoLanc54DateBrt) return "lag";
  if (bastaoOcDateBrt > ultimoLanc54DateBrt) return "nova";
  return "ambiguo";
}

/** Converte um timestamptz ISO pra data BRT (UTC-3, sem DST — padrão do codebase). */
export function dataBrtDeTimestamp(isoTs: string): string {
  const ms = new Date(isoTs).getTime() - 3 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Busca a data BRT do último lançamento de oc=54 bem-sucedido do Cockpit pro card
 * em `acoes_executadas_ssw`. Null se nunca lançou 54.
 */
export async function ultimaDataLancamento54Brt(
  supabase: SupabaseClient,
  cardId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("acoes_executadas_ssw")
    .select("iniciado_em")
    .eq("card_id", cardId)
    .eq("codigo_oc", 54)
    .eq("sucesso", true)
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ts = (data as { iniciado_em?: string } | null)?.iniciado_em;
  return ts ? dataBrtDeTimestamp(ts) : null;
}

/**
 * Conveniência: o card em AGUARDANDO_CLIENTE NÃO deve ser rebaixado pra AGUARDANDO
 * VOCÊ porque a oc do Bastão é a ANTERIOR lagando após o Cockpit lançar 54?
 */
export async function naoRebaixarPorLancamento54(
  supabase: SupabaseClient,
  cardId: string,
  bastaoOcDateBrt: string | null,
): Promise<boolean> {
  const lanc = await ultimaDataLancamento54Brt(supabase, cardId);
  return ehLagDeLancamento54PorData(bastaoOcDateBrt, lanc);
}

// ===========================================================================
// GENERALIZAÇÃO (Caio 2026-06-25, NF 351193 + 10415): "TODA oc lançada pelo
// Cockpit suprime o re-lock". O fix de ontem só cobria oc=54; a 351193 lançou
// 56 e voltou travada em AGUARDANDO VOCÊ porque o Bastão lagou na oc anterior
// (49). A regra agora é por DATA contra QUALQUER lançamento bem-sucedido do
// Cockpit: se a oc do Bastão não é mais nova que o último lançamento, é lag →
// o card NÃO pode ser re-proposto/re-trancado/reaberto (a ação do operador já
// moveu o card — respeitar). Fonte durável = acoes_executadas_ssw (não os
// campos voláteis acao_executada_em/bastao_oc_no_lancamento).
// ===========================================================================

/**
 * Data BRT do último lançamento bem-sucedido do Cockpit pro card — QUALQUER oc
 * (não só 54). Null se o Cockpit nunca lançou nada (ex.: card de extravio).
 */
export async function ultimaDataLancamentoCockpitBrt(
  supabase: SupabaseClient,
  cardId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("acoes_executadas_ssw")
    .select("iniciado_em")
    .eq("card_id", cardId)
    .eq("sucesso", true)
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ts = (data as { iniciado_em?: string } | null)?.iniciado_em;
  return ts ? dataBrtDeTimestamp(ts) : null;
}

/**
 * A oc do Bastão é lag de um lançamento do Cockpit (QUALQUER oc)? Mesmo
 * discriminador por data do `ehLagDeLancamento54PorData`, generalizado.
 * true = lag/stale → respeitar a ação do operador (não re-propor/re-trancar).
 */
export async function ehLagDeLancamentoCockpit(
  supabase: SupabaseClient,
  cardId: string,
  bastaoOcDateBrt: string | null,
): Promise<boolean> {
  const lanc = await ultimaDataLancamentoCockpitBrt(supabase, cardId);
  return ehLagDeLancamento54PorData(bastaoOcDateBrt, lanc);
}
