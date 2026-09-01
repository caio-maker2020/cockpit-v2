// =============================================================================
// devolucao-cte-proposta.ts — o que FAZER quando o detector reconhece um CT-e.
//
// Decisão pura, separada do efeito. É a peça que liga o detector ao resto: sem
// ela nada do que já está construído (ciclo, proposta, oc 44, e-mail ao setor)
// chega a ser acionado.
//
// A PROPRIEDADE MAIS IMPORTANTE DAQUI — criar `devolucoes_cte` NÃO é neutro:
// depois dela, `filtrarPropostas44SemCte` tira a 44 pelada e os combos do menu,
// e `motivoBloqueio44SemCte` recusa 44 sem anexo no envelope. Ou seja, abrir o
// ciclo MUDA o que a operadora vê e pode fazer.
//
// Consequência, que é regra e não detalhe:
//   · modo SOMBRA (degrau 3) não abre ciclo — senão deixa de ser observação e
//     passa a alterar o menu de cards reais;
//   · nível B não abre ciclo — a decisão nº 9 diz que ele só SINALIZA, e tirar
//     opções do menu com base em prova indireta é agir.
// Só o nível A com a feature LIGADA abre ciclo. Aí a cerca é desejada: o CT-e
// está provado presente.
// =============================================================================
import { CODIGO_SSW_44, TOOL_44_DEVOLUCAO_CTE } from "./devolucao-cte-44.ts";
import type { NivelDeteccao } from "./devolucao-cte-detector.ts";

export type AcaoProposta =
  /** Nada a fazer — fora de escopo, sem detecção, ou já proposto. */
  | "nada"
  /** Só registra o que TERIA feito (degrau 3). Nenhum efeito visível. */
  | "sombra"
  /** Avisa a operadora ("parece ter chegado um CT-e — confira"). Não age. */
  | "sinalizar"
  /** Abre o ciclo e cria a proposta de oc 44 com o CT-e. */
  | "propor";

export interface EntradaDecisaoProposta {
  /** Resultado do detector: "A" = prova na própria mensagem, "B" = na conversa. */
  nivel: NivelDeteccao | null;
  /** `devolucao_cte_em_escopo(cnpj_pagador)` — a carteira da MARIA. */
  emEscopo: boolean;
  /** flag `devolucao_cte_shadow` (degrau 3). */
  flagShadow: boolean;
  /** flag `devolucao_cte_maria_enabled` (degrau 4). */
  flagEnabled: boolean;
  /** Já existe proposta ATIVA desta tool no card? (idempotência) */
  jaExisteTodoAtivo: boolean;
  /** Já existe ciclo ABERTO com CT-e registrado? (o detector redispara na thread) */
  cicloJaTemCte: boolean;
}

export interface DecisaoProposta {
  acao: AcaoProposta;
  /** Vai pro card_event — é o que a Maria e a auditoria leem. */
  motivo: string;
  /** Pode abrir/atualizar `devolucoes_cte`? Só o caminho "propor". */
  abreCiclo: boolean;
}

export function decidirAcaoProposta(e: EntradaDecisaoProposta): DecisaoProposta {
  const nada = (motivo: string): DecisaoProposta => ({ acao: "nada", motivo, abreCiclo: false });

  // Fora da carteira da MARIA nada acontece, em nenhum modo. É a cerca que
  // protege Larissa/Karoline/Ingrid, e ela vem antes de tudo.
  if (!e.emEscopo) return nada("fora_do_escopo");
  if (e.nivel === null) return nada("sem_deteccao");

  // Feature inteiramente desligada: nem sombra. Degrau 0/1/2.
  if (!e.flagShadow && !e.flagEnabled) return nada("flags_desligadas");

  // SOMBRA (degrau 3): registra e não toca em nada. Vale pros dois níveis —
  // "detecta os CT-es reais, zero proposta criada" é o critério de subida.
  // `enabled` vence `shadow`: o degrau 4 substitui o 3, não soma.
  if (!e.flagEnabled) {
    return { acao: "sombra", motivo: `sombra_nivel_${e.nivel}`, abreCiclo: false };
  }

  // Nível B: só sinaliza (decisão nº 9). NÃO abre ciclo — abrir mudaria o menu
  // da operadora com base em prova indireta, e isso é agir.
  if (e.nivel === "B") {
    return { acao: "sinalizar", motivo: "nivel_b_prova_apenas_na_conversa", abreCiclo: false };
  }

  // Nível A com a feature ligada. Idempotência primeiro: o detector redispara a
  // cada anexo novo da mesma thread.
  if (e.jaExisteTodoAtivo) return nada("proposta_ativa_ja_existe");
  if (e.cicloJaTemCte) return nada("ciclo_ja_tem_cte_registrado");

  return { acao: "propor", motivo: "nivel_a_prova_na_propria_mensagem", abreCiclo: true };
}

// -----------------------------------------------------------------------------
// Payload da proposta
// -----------------------------------------------------------------------------

export interface DadosProposta44 {
  cicloId: string;
  nf: string;
  /** Nome do arquivo do CT-e — a operadora confere na tela. */
  nomeArquivoCte: string | null;
  /** Volumes do CTRC, quando o card sabe. Prefill: ela CONFIRMA, não redigita. */
  quantidadeVolumes?: number | null;
  /** Sinais do nome do arquivo que o detector juntou (auditoria). */
  sinaisNome?: string[];
}

/**
 * Monta o `proposta_payload` do todo.
 *
 * `acao_key` é SEMPRE carimbada (R19): sem ela a cerca anti-duplicação do veto
 * compara `NaN` e se desarma em silêncio.
 *
 * `extras.quantidade_volumes` entra como PREFILL quando o card sabe os volumes
 * do CTRC — o painel mostra preenchido pra ela confirmar. Sem o fallback de
 * prefill da oc 44 no front (R13), este valor apareceria vazio e ela redigitaria
 * por cima. Motivo e filial ficam em branco de propósito: não se inventa o que
 * não se leu no documento.
 */
export function montarPropostaPayload44(d: DadosProposta44): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  if (typeof d.quantidadeVolumes === "number" && d.quantidadeVolumes > 0) {
    extras["quantidade_volumes"] = String(d.quantidadeVolumes);
  }
  return {
    tool: TOOL_44_DEVOLUCAO_CTE,
    acao_key: `${TOOL_44_DEVOLUCAO_CTE}:${CODIGO_SSW_44}`,
    args: {
      codigo_ssw: CODIGO_SSW_44,
      nf: d.nf,
      // O handler do executor EXIGE este campo: sem o ciclo não há como provar
      // que o CT-e é deste caso.
      devolucao_cte_id: d.cicloId,
      descricao: "Cliente autorizou devolução — CT-e de devolução anexado",
      extras,
    },
    meta: {
      origem: "devolucao-cte-detector",
      nivel: "A",
      nome_arquivo_cte: d.nomeArquivoCte,
      sinais_nome: d.sinaisNome ?? [],
    },
  };
}

/** Descrição do todo — é o texto que a operadora lê na lista. */
export function descricaoTodo44Cte(nomeArquivo: string | null): string {
  const arq = (nomeArquivo ?? "").trim();
  return arq
    ? `Lançar oc 44 no SSW com o CT-e de devolução (${arq}) + avisar o setor de Devolução`
    : "Lançar oc 44 no SSW com o CT-e de devolução + avisar o setor de Devolução";
}
