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

/**
 * Decide (PURO) se o Pass D do sync-bastao deve PRESERVAR o banner de recomendação
 * do agente (aviso.tipo === 'ia_sugestao_ocs_padrao') em vez de sobrescrevê-lo com
 * o aviso pelado de divergência de oc.
 *
 * Caio 2026-06-29 (refino NF 705764): preserva SÓ quando a oc do Bastão é
 * PROVADAMENTE anterior, por DATA, ao último lançamento do Cockpit
 * (`classificarPorData === 'lag'`, estritamente antes). MESMO DIA ('ambiguo') NÃO
 * conta como lag confirmado — com 6000+ entregas/dia mesmo-dia é a NORMA e pode
 * esconder uma oc genuinamente nova (lição INV-023) → o caller cai no comportamento
 * normal (Pass D sinaliza a divergência). POSTERIOR ('nova') e SEM lançamento do
 * Cockpit ('nova') → idem, não preserva. Diferente de `ehLagDeLancamentoCockpit`,
 * que usa `<=` e contaria mesmo-dia como lag.
 */
export function passDDevePreservarBannerIaSugestao(
  avisoTipo: string | null | undefined,
  classe: ClasseRebaixa,
): boolean {
  return avisoTipo === "ia_sugestao_ocs_padrao" && classe === "lag";
}

// ===========================================================================
// VERDADE DO SSW POR HORA (Caio 2026-06-25, NF 346778 — raiz definitiva).
//
// Problema da raiz: o discriminador por DATA (acima) não distingue duas
// ocorrências no MESMO DIA. Com 6000+ entregas/dia, mesmo-dia é a NORMA, então
// data esconde oc de relacionamento genuinamente nova (Cockpit lançou oc X às
// 09:23, operação lançou oc 49 nova às 09:47 → suprimida errado, card sumiu).
//
// Fonte de verdade = SSW (o histórico tem a HORA de cada ocorrência, "DD/MM/YY
// HH:MM"). O Bastão (só data) é o GATILHO; o SSW é o DECISOR. Custo controlado
// no caller (fast-path por data + cache-first + amarrado ao fluxo, não ao
// estoque). Funções PURAS, testáveis.
// ===========================================================================

// parseSswDataHoraBrt: FONTE ÚNICA em ssw-data-hora.ts (re-export pra quem importa
// daqui — testes e o discriminador abaixo continuam funcionando).
export { parseSswDataHoraBrt } from "./ssw-data-hora.ts";

export type DecisaoReabertura = "reabrir" | "suprimir" | "indefinido";

/**
 * Decide (PURO) se um card parado/protegido cujo Bastão sinaliza oc de
 * relacionamento deve REABRIR pro relacionamento, usando a VERDADE DO SSW
 * (ocorrência mais recente real + hora) em vez da data do Bastão.
 *
 * Regra (lean "SSW aponta relacionamento → reabre", Caio 2026-06-25):
 *   - SSW não deu oc (fora do ar / sem oc) → "indefinido" (caller faz retry).
 *   - SSW.oc === 54 OU não é de relacionamento → "suprimir" (Cockpit moveu certo;
 *     ex.: 351193 lançou 56, SSW mais recente = 56).
 *   - SSW.oc relacionamento ≠54 + nunca lançou pelo Cockpit (extravio) → "reabrir".
 *   - SSW.oc relacionamento ≠54 sem hora parseável → "reabrir" (SSW aponta relac).
 *   - SSW.oc relacionamento ≠54 com hora < lançamento → "suprimir" (provadamente a
 *     anterior lagando — único caso que o tempo barra; mata o bounce-back 10415/351193).
 *   - senão (hora >= lançamento, inclui empate de minuto) → "reabrir" (oc nova genuína).
 */
export function decidirReaberturaPorSsw(args: {
  ocSswMaisRecente: number | null;
  ocSswMaisRecenteMs: number | null;
  ehRelac: (oc: number) => boolean;
  ultimoLancamentoCockpitMs: number | null;
}): DecisaoReabertura {
  const { ocSswMaisRecente, ocSswMaisRecenteMs, ehRelac, ultimoLancamentoCockpitMs } = args;
  if (ocSswMaisRecente == null) return "indefinido";
  if (ocSswMaisRecente === 54) return "suprimir";
  if (!ehRelac(ocSswMaisRecente)) return "suprimir";
  // Daqui pra baixo: SSW mostra oc de relacionamento ≠54.
  if (ultimoLancamentoCockpitMs == null) return "reabrir";
  if (ocSswMaisRecenteMs == null) return "reabrir";
  if (ocSswMaisRecenteMs < ultimoLancamentoCockpitMs) return "suprimir";
  return "reabrir";
}

/**
 * epoch ms (UTC) do último lançamento bem-sucedido do Cockpit pro card — QUALQUER
 * oc. Null se nunca lançou. Irmã de `ultimaDataLancamentoCockpitBrt`, mas devolve
 * o instante exato (não só a data) pra comparar com a hora da ocorrência do SSW.
 */
export async function ultimoLancamentoCockpitMs(
  supabase: SupabaseClient,
  cardId: string,
): Promise<number | null> {
  const { data } = await supabase
    .from("acoes_executadas_ssw")
    .select("iniciado_em")
    .eq("card_id", cardId)
    .eq("sucesso", true)
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ts = (data as { iniciado_em?: string } | null)?.iniciado_em;
  return ts ? new Date(ts).getTime() : null;
}
