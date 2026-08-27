// =============================================================================
// resposta-sem-acao — devolução ao terminal (Caio 27/08, caso NF 660746).
//
// Cenário: card TERMINAL (TRANSFERIDO/RESOLVIDO) reaberto pela resposta do
// cliente (regra "resposta nunca fica muda") — mas a leitura do interpretador
// conclui que a resposta NÃO pede ação nenhuma (ex.: cliente só entregou o
// romaneio pedido; "a 55 reflete o acordo já combinado"). Antes, o card
// ficava em AGUARDANDO VOCÊ com o menu completo armado — e foi nesse vácuo
// que a 33 prematura da 660746 aconteceu. Agora: o card VOLTA sozinho pro
// estado anterior; a resposta fica anexada e a leitura registrada.
//
// A proteção original fica intacta: resposta que PEDE algo (pendência, decisão,
// oc diferente, combos, leitura parcial/degradada) mantém o card aberto.
// =============================================================================

export interface LeituraPraDevolucao {
  oc_sugerida: number | null;
  pendencias: readonly string[];
  sugere_oc33_solo: boolean;
  sugere_combo_33_44: boolean;
  sugere_combo_44_59: boolean;
  leitura_parcial: boolean;
  leitura_degradada: boolean;
  /** tipo do destaque resolvido ('aguardar' = interpretador mandou não agir) */
  tipo_destaque?: string | null;
}

/** PURO (INV-118): a resposta não pede ação NENHUMA?
 *  - destaque 'aguardar' (interpretador mandou esperar) → sem ação;
 *  - OU a oc sugerida é EXATAMENTE a última oc que o Cockpit já lançou com
 *    sucesso no card (compara com acoes_executadas_ssw — imune à defasagem
 *    do Bastão) e não há pendências;
 *  - qualquer sinal de trabalho (pendência, combo, 33, leitura parcial ou
 *    degradada) → TEM ação, card fica aberto. */
export function ehRespostaSemAcao(
  l: LeituraPraDevolucao,
  ultimaOcCockpit: number | null,
): boolean {
  if (l.leitura_parcial || l.leitura_degradada) return false;
  if (l.sugere_oc33_solo || l.sugere_combo_33_44 || l.sugere_combo_44_59) return false;
  if ((l.pendencias?.length ?? 0) > 0) return false;
  if (l.tipo_destaque === "aguardar") return true;
  return l.oc_sugerida != null && ultimaOcCockpit != null && l.oc_sugerida === ultimaOcCockpit;
}

export const STATES_DEVOLVIVEIS: ReadonlySet<string> = new Set(["TRANSFERIDO", "RESOLVIDO"]);
