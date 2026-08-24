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
import { OCS_CLIENTE } from "./bastao-rules.ts";

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
 * Busca a data BRT do último lançamento de oc de CLIENTE ({54,59}) bem-sucedido do
 * Cockpit pro card em `acoes_executadas_ssw`. Null se nunca lançou 54/59.
 *
 * Caio 2026-07-13 (separação 54/59, Bloco 7): antes filtrava SÓ `codigo_oc=54`.
 * Com a 59 (RETORNO INDENIZAÇÃO) também residindo em AGUARDANDO_CLIENTE, um card
 * que foi pra lá por um lançamento de 59 tinha launchDate=null aqui → o fast-path
 * de `naoRebaixarComDesempateSsw` classificava "nova" → BOUNCE-BACK pra AGUARDANDO
 * VOCÊ (a exata regressão INV-019 que este arquivo existe pra matar). Fonte única:
 * OCS_CLIENTE. O alias `ultimaDataLancamento54Brt` mantém os callers existentes.
 */
export async function ultimaDataLancamentoClienteBrt(
  supabase: SupabaseClient,
  cardId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("acoes_executadas_ssw")
    .select("iniciado_em")
    .eq("card_id", cardId)
    .in("codigo_oc", [...OCS_CLIENTE])
    .eq("sucesso", true)
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ts = (data as { iniciado_em?: string } | null)?.iniciado_em;
  return ts ? dataBrtDeTimestamp(ts) : null;
}

/** Alias de compatibilidade — os callers (sync-bastao, health-check) seguem
 * chamando este nome; a cobertura agora é {54,59} via OCS_CLIENTE. */
export const ultimaDataLancamento54Brt = ultimaDataLancamentoClienteBrt;

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

// ===========================================================================
// FORCE oc=54 vs LANÇAMENTO DO COCKPIT (Caio 2026-08-24, NF 1611059).
//
// O force "oc=54 ⟺ AGUARDANDO_CLIENTE" do Pass A arrastava de volta cards que
// o Cockpit ACABAVA de mover (lançou 21 → TRANSFERIDO; 18min depois o Bastão,
// ainda lagado na 54 de ontem, forçava AGUARDANDO_CLIENTE). A trava antiga
// (NF 376924) media o prazo de 24h pela idade do REGISTRO DO BASTÃO no
// lançamento — que quase sempre já nasce >24h velho (cliente demora 1+ dia
// pra responder) → trava morta em 643 bounces/611 cards em 30d.
//
// Discriminador correto = o MESMO da regra inviolável de 25/06: a DATA do
// último lançamento bem-sucedido em acoes_executadas_ssw (fonte durável).
// Bastão 54 datada <= lançamento ≠54 → é a NOSSA 54 antiga lagando → NÃO força.
// ===========================================================================

export interface UltimoLancamentoCockpit {
  codigoOc: number;
  dataBrt: string; // YYYY-MM-DD
}

/**
 * Último lançamento bem-sucedido do Cockpit pro card, com código E data BRT.
 * Null se nunca lançou nada.
 */
export async function ultimoLancamentoCockpitInfo(
  supabase: SupabaseClient,
  cardId: string,
): Promise<UltimoLancamentoCockpit | null> {
  const { data } = await supabase
    .from("acoes_executadas_ssw")
    .select("codigo_oc, iniciado_em")
    .eq("card_id", cardId)
    .eq("sucesso", true)
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as { codigo_oc?: number; iniciado_em?: string } | null;
  if (!row?.iniciado_em || row.codigo_oc == null) return null;
  return { codigoOc: row.codigo_oc, dataBrt: dataBrtDeTimestamp(row.iniciado_em) };
}

/**
 * Decide (PURO) se o force oc=54 deve ser SUPRIMIDO porque a 54 do Bastão é a
 * anterior lagando por cima de um lançamento ≠54 do Cockpit.
 *   - Nunca lançou nada → false (force segue — card sem ação do Cockpit).
 *   - Último lançamento foi oc de CLIENTE ({54,59}) → false (AGUARDANDO_CLIENTE
 *     é o destino CERTO desse lançamento — fluxo normal intacto).
 *   - Último lançamento ≠54 e Bastão 54 datada <= lançamento → true (lag; a
 *     regra inviolável de 25/06 manda respeitar a ação do operador).
 *   - Bastão 54 datada DEPOIS do lançamento ≠54 → false (54 genuinamente nova
 *     — alguém lançou 54 por fora depois da nossa ação → force correto).
 *   - Sem data do Bastão mas com lançamento ≠54 → true (conservador, mesma
 *     convenção do ehLagDeLancamento54PorData).
 * Mesmo-dia conta como lag (<=): se uma 54 nova real cair no mesmo dia, a data
 * do Bastão fica > lançamento no ciclo do dia seguinte e o force passa — o
 * atraso máximo é 1 dia, contra bounce imediato garantido no outro sentido.
 */
export function deveSuprimirForceOc54PorLancamento(
  bastaoOc54DateBrt: string | null,
  ultimoLancamento: UltimoLancamentoCockpit | null,
): boolean {
  if (!ultimoLancamento) return false;
  if (OCS_CLIENTE.has(ultimoLancamento.codigoOc)) return false;
  if (!bastaoOc54DateBrt) return true;
  return bastaoOc54DateBrt <= ultimoLancamento.dataBrt;
}

// ===========================================================================
// VALIDADE DE CACHE POR EVENTO (Caio 2026-08-24, NFs 387848/680392).
//
// Cache do histórico SSW com validade por RELÓGIO (4h/24h) tratava como
// "fresco" um cache puxado MINUTOS ANTES do lançamento do Cockpit — o
// operador abre o card (front grava cache, topo 54), aprova, o Cockpit lança
// 44/21, e o sync decide pelo cache pré-lançamento (420 bounces/30d na porta
// da identidade; reabertura da 680392 9min após resolvida). Regra: cache só
// é utilizável se foi puxado DEPOIS do último lançamento do Cockpit —
// senão é semanticamente velho, independente da idade.
// ===========================================================================

/**
 * PURO: o cache do histórico SSW pode embasar decisão?
 *   - sem timestamp → não;
 *   - idade >= frescoMs (janela de relógio, ex. 4h) → não;
 *   - puxado ANTES (ou no instante) do último lançamento do Cockpit → não
 *     (é pré-evento: não enxerga a ação que acabamos de executar);
 *   - sem lançamento do Cockpit → só a janela de relógio decide.
 */
export function cacheSswUtilizavel(args: {
  cacheEmMs: number | null;
  agoraMs: number;
  frescoMs: number;
  ultimoLancamentoMs: number | null;
}): boolean {
  if (args.cacheEmMs == null || !Number.isFinite(args.cacheEmMs)) return false;
  if (args.agoraMs - args.cacheEmMs >= args.frescoMs) return false;
  if (args.ultimoLancamentoMs != null && args.cacheEmMs <= args.ultimoLancamentoMs) return false;
  return true;
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
  // Caio 2026-07-13 (separação 54/59): oc de CLIENTE {54,59} mais recente no SSW =
  // Cockpit moveu certo → suprimir. 59 já cairia em `!ehRelac(59)` (59 não é
  // relacionamento), mas explicitar é defesa-em-profundidade se 59 vazar pro set relac.
  if (ocSswMaisRecente === 54 || ocSswMaisRecente === 59) return "suprimir";
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

/**
 * FIX NF 693044 (Caio 2026-08-20) — inanição do sweep INV-019.
 *
 * O sweep avalia cada card preso com `naoRebaixarComDesempateSsw`: casos "nova"
 * decidem DE GRAÇA (só data, zero SSW); "lag"/"ambiguo" custam uma consulta SSW
 * (segundos cada). Com a varredura em ordem arbitrária do banco, 12 cards lentos
 * na frente esgotavam o orçamento (20s pré-Pass A / deadline global) ANTES de o
 * sweep alcançar um card trivialmente curável — inanição determinística, ciclo
 * após ciclo (NF 693044 ficou presa o dia inteiro na posição 13).
 *
 * Ordena os presos pelo CUSTO da decisão: "nova" primeiro (baratos, curáveis
 * agora), depois "ambiguo"/"lag" (SSW). Puro pra ser testável.
 */
export function ordenarPresosPorCustoDeDecisao<T>(
  itens: readonly T[],
  classeDe: (item: T) => ClasseRebaixa,
): T[] {
  const peso: Record<ClasseRebaixa, number> = { nova: 0, ambiguo: 1, lag: 2 };
  return itens
    .map((item, i) => ({ item, i, p: peso[classeDe(item)] }))
    .sort((a, b) => a.p - b.p || a.i - b.i) // estável: empate mantém ordem original
    .map((x) => x.item);
}
