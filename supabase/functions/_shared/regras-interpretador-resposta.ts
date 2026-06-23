// =============================================================================
// regras-interpretador-resposta — guards determinísticos sobre a saída do
// interpretador-resposta-cliente. Funções PURAS (sem rede/DB), testáveis,
// travam regressão (CLAUDE.md: toda regra de negócio vira guard de código).
//
// INV-017 (Caio 2026-06-23, NF 16480 SUPER INDUSTRIA C. / Caffeine Army):
// a sugestão da IA NÃO pode contradizer as pendências que ela mesma detectou.
// Caso âncora: cliente respondeu "está alinhando nova tentativa de entrega e
// pediu para aguardar confirmação". O interpretador sugeriu LANÇAR oc 21
// (reentrega, confiança 72%) E, no mesmo payload, listou a pendência "cliente
// não confirmou novo endereço ou data para a reentrega". O front renderiza os
// DOIS banners a partir do mesmo `cards.ia_sugestao_oc_resposta` → operador vê
// "🤖 lançar oc 21" e "⚠ responder cliente cobrando" ao mesmo tempo.
//
// oc=21 = reentrega CONFIRMADA. Se o cliente só pediu pra aguardar (pendência
// aberta sobre os dados da reentrega), a ação correta é MANTER aguardando (54)
// + responder cobrando — NUNCA lançar a reentrega. Este módulo rebaixa 21 → 54
// determinísticamente, independentemente de o prompt acertar ou não.
// =============================================================================

export interface SugestaoInterpretador {
  oc_sugerida: number;
  confianca: number;
  instrucao_reentrega_sugerida: string;
  pendencias_resposta_cliente: string[];
  /** Caio 2026-05-18: cliente autorizou reentrega mas se nega a pagar a viagem. */
  cliente_autorizou_reentrega_sem_pagar: boolean;
}

export interface ReconciliacaoResultado<T extends SugestaoInterpretador> {
  sugestao: T;
  /** true quando o guard INV-017 rebaixou oc=21 → 54 por pendência aberta. */
  rebaixou_oc21_por_pendencia: boolean;
  /** oc que a IA havia sugerido antes do rebaixamento (pra auditoria). */
  oc_original?: number;
}

/** Confiança é capada nesse teto quando rebaixamos: a decisão deixou de ser
 *  "reentrega confirmada", então não pode carregar confiança alta. */
export const CONFIANCA_MAX_AO_REBAIXAR = 0.5;

/**
 * Reconcilia a sugestão do interpretador aplicando guards determinísticos que
 * travam contradições internas. Hoje só INV-017 (oc=21 vs pendências abertas).
 *
 * Regra INV-017:
 *   oc_sugerida === 21  E  há pendência aberta  E  cliente NÃO autorizou
 *   reentrega explicitamente (flag sem_pagar) → rebaixa pra 54:
 *     - oc_sugerida = 54
 *     - confianca = min(confianca, 0.5)
 *     - instrucao_reentrega_sugerida = "" (não há reentrega a instruir)
 *     - pendências mantidas (banner "responder cliente" continua)
 *
 * EXCEÇÃO (preserva feature Caio 2026-05-18): se
 * cliente_autorizou_reentrega_sem_pagar === true o cliente deu aval EXPLÍCITO
 * de reentrega ("podem tentar de novo") — aí a pendência não bloqueia e mantém 21.
 *
 * NÃO toca em 44/33/55: essas ocs têm casos âncora legítimos COM pendência
 * (ex: oc=55 NF 343885 "cliente não anexou romaneio" + autorizou seguir parcial).
 * Genérico em <T> pra preservar campos extras do chamador (motivo, etc).
 */
export function reconciliarSugestaoInterpretador<T extends SugestaoInterpretador>(
  s: T,
): ReconciliacaoResultado<T> {
  const temPendencia =
    Array.isArray(s.pendencias_resposta_cliente) &&
    s.pendencias_resposta_cliente.length > 0;

  const deveRebaixar =
    s.oc_sugerida === 21 &&
    temPendencia &&
    s.cliente_autorizou_reentrega_sem_pagar !== true;

  if (!deveRebaixar) {
    return { sugestao: s, rebaixou_oc21_por_pendencia: false };
  }

  return {
    sugestao: {
      ...s,
      oc_sugerida: 54,
      confianca: Math.min(s.confianca, CONFIANCA_MAX_AO_REBAIXAR),
      instrucao_reentrega_sugerida: "",
    },
    rebaixou_oc21_por_pendencia: true,
    oc_original: 21,
  };
}
