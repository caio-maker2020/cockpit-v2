// =============================================================================
// oc13-sugestao-aviso.ts — fonte única do DESTAQUE da sugestão do agente-oc13 e
// do FILTRO de seleção dos cards que ele analisa (INV-174, Caio 2026-10-08).
//
// POR QUE EXISTE (diagnóstico de 08/10, pedido do Duilio):
//   1. O carimbo `sugestao_vigente` da aprovação (mig 378) lê SÓ
//      `aviso_alteracao_oc.proposta_destacada` (número) e `.proposta_destacada_acao`
//      (acao_key). O agente-oc13 nunca escrevia o número e mandava acao_key NULA
//      no ramo 21+cancelar → 22 de 22 aprovações de setembro após "sugerir_21_cancel"
//      ficaram com carimbo vazio e entraram no I2 como "ação sem sugestão".
//   2. O `.or()` da seleção tinha `and(analise_oc13_atualizado_em.lt.X)` SOLTO
//      (precedência), desde o nascimento do agente (79cc39c, 21/05): todo card
//      concluído era reanalisado a cada 10 min até o teto de 3 tentativas —
//      2,6–2,8 eventos AgenteOc13Decisao por card, decisão nunca mudou (0/114 em
//      set), e a re-análise que FALHAVA sobrescrevia a análise boa com `erro_msg`
//      (par perdido no placar). O filtro agora é montado aqui e testado.
//
// REGRA: o número da oc vai em `proposta_destacada`; a acao_key do banner vai
// em `proposta_destacada_acao` (carimbo). O ramo 21 NÃO ganha acao_key na
// `analise_oc13_resultado` (campo que o popup F4 de divergência lê) — a UX do
// operador não muda neste fix; estender o popup à 21 é decisão à parte.
// Testes: oc13-sugestao-aviso.test.ts
// =============================================================================

import { acaoKey } from "./regras-auto-acao.ts";

export type DecisaoSugestaoOc13 = "sugerir_54_email" | "sugerir_56" | "sugerir_21_cancel";

export interface DestaqueSugestaoOc13 {
  /** número da oc sugerida — vai em aviso_alteracao_oc.proposta_destacada (carimbo) */
  proposta_destacada: 54 | 56 | 21;
  /** acao_key da ação recomendada — vai em aviso_alteracao_oc.proposta_destacada_acao (carimbo) */
  proposta_destacada_acao: string;
  /** acao_key gravada em analise_oc13_resultado (popup F4 lê daqui) — null no ramo 21, como sempre foi */
  analise_acao_key: string | null;
  sugestaoLabel: string;
  tipoAviso: string;
}

export function ehDecisaoSugestaoOc13(d: string | null | undefined): d is DecisaoSugestaoOc13 {
  return d === "sugerir_54_email" || d === "sugerir_56" || d === "sugerir_21_cancel";
}

/**
 * Destaque da sugestão manual do agente-oc13. Caio 2026-07-01 (NF 1093446,
 * INV-027): o front casa o banner por acao_key — "54" sozinho é ambíguo entre
 * "+ e-mail" e "sem e-mail"; sugerir_54_email ⇒ a ação recomendada É a que
 * ENVIA e-mail. 56 sem gêmea. 21+cancel casa por número no front (sem gêmea
 * de e-mail), mas o CARIMBO precisa da chave — por isso ela existe aqui.
 */
export function destaqueSugestaoOc13(decisao: DecisaoSugestaoOc13): DestaqueSugestaoOc13 {
  switch (decisao) {
    case "sugerir_54_email": {
      const k = acaoKey("lancar_oc_e_enviar_email", 54);
      return {
        proposta_destacada: 54,
        proposta_destacada_acao: k,
        analise_acao_key: k,
        sugestaoLabel: "oc=54+email",
        tipoAviso: "ia_sugestao_oc13",
      };
    }
    case "sugerir_56": {
      const k = acaoKey("lancar_ocorrencia", 56);
      return {
        proposta_destacada: 56,
        proposta_destacada_acao: k,
        analise_acao_key: k,
        sugestaoLabel: "oc=56",
        tipoAviso: "ia_sugestao_oc13_revisar",
      };
    }
    case "sugerir_21_cancel":
      return {
        proposta_destacada: 21,
        proposta_destacada_acao: acaoKey("lancar_ocorrencia", 21),
        analise_acao_key: null,
        sugestaoLabel: "oc=21 + cancelar reentrega",
        tipoAviso: "ia_sugestao_oc13_21_cancel",
      };
  }
}

/**
 * Filtro PostgREST (`.or(...)`) dos cards elegíveis à análise do agente-oc13.
 * Entra: nunca analisado, pendente/falhou (retry), ou `analisando` TRAVADO há
 * mais de `limiteRetryIso`. NÃO entra: `concluida` — card analisado não é
 * reanalisado sozinho (a re-análise por entrada nova é outro mecanismo).
 * Mesma forma do agente-sugere-ocs-padrao.
 */
export function filtroSelecaoCardsOc13(limiteRetryIso: string): string {
  return [
    "analise_oc13_status.is.null",
    "analise_oc13_status.in.(pendente,falhou)",
    `and(analise_oc13_status.eq.analisando,analise_oc13_atualizado_em.lt.${limiteRetryIso})`,
  ].join(",");
}
