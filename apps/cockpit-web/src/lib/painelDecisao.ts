// =============================================================================
// painelDecisao — "1 CARD = 1 DECISÃO" (Caio 26/08: o card empilhava até 9
// banners e ninguém enxergava nada; o modo foco não resolvia sozinho).
//
// Este seletor PURO escolhe O VENCEDOR — a única coisa que o operador precisa
// decidir agora — numa TABELA DE PRIORIDADE fixa. O vencedor renderiza em
// destaque; todo o resto vira a seção compacta "outros avisos" (colapsada).
// Banner novo no futuro entra NESTA tabela, nunca numa pilha.
//
// Prioridade (de cima pra baixo, primeiro ativo vence):
//   1. oc_mudou        — o mundo mudou; decidir qualquer coisa antes é risco
//   2. acao_autonoma   — countdown correndo; o relógio manda
//   3. falha           — ação falhou/bounce; destravar vem antes de sugerir
//   4. sugestao_resposta — cliente respondeu + leitura da IA
//   5. sugestao_padrao — sugestão do agente de ocs-padrão
//   null               — sem decisão destacada (card informativo)
// =============================================================================

import type { CardRow } from "./types";
import { detectarOcorrenciaMudou } from "./ocorrenciaMudou";

export type VencedorPainel =
  | "oc_mudou"
  | "acao_autonoma"
  | "falha"
  | "sugestao_resposta"
  | "sugestao_padrao"
  | null;

export const PRIORIDADE_PAINEL: Exclude<VencedorPainel, null>[] = [
  "oc_mudou",
  "acao_autonoma",
  "falha",
  "sugestao_resposta",
  "sugestao_padrao",
];

/** PURO: sinais ativos do card (cada um mapeia pra um banner existente). */
export function sinaisAtivos(card: CardRow): Set<Exclude<VencedorPainel, null>> {
  const s = new Set<Exclude<VencedorPainel, null>>();
  const estadoFinal = ["TRANSFERIDO", "RESOLVIDO", "CANCELADO"].includes(card.state);

  if (!estadoFinal && detectarOcorrenciaMudou(card)) s.add("oc_mudou");

  const esp = card.acao_autonoma;
  if (esp?.status === "pendente" || esp?.status === "executando") s.add("acao_autonoma");

  if (card.acao_falhou_motivo || card.ultimo_bounce_payload) s.add("falha");

  if (card.ia_sugestao_oc_resposta) s.add("sugestao_resposta");

  const aviso = card.aviso_alteracao_oc as { tipo?: string } | null;
  if (aviso?.tipo === "ia_sugestao_ocs_padrao" || card.analise_padrao_resultado || card.analise_oc13_resultado) {
    s.add("sugestao_padrao");
  }
  return s;
}

/** PURO: o vencedor pela tabela de prioridade — exatamente UM (ou nenhum). */
export function escolherVencedor(card: CardRow): VencedorPainel {
  const ativos = sinaisAtivos(card);
  for (const p of PRIORIDADE_PAINEL) if (ativos.has(p)) return p;
  return null;
}

/** Quantos sinais ficam ATRÁS do vencedor (pro rótulo "outros avisos (N)"). */
export function outrosAvisos(card: CardRow): number {
  const ativos = sinaisAtivos(card);
  return Math.max(0, ativos.size - (escolherVencedor(card) ? 1 : 0));
}
