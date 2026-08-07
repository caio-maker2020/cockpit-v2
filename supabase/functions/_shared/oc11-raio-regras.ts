// =============================================================================
// oc11-raio-regras.ts — regra de decisão da OCORRÊNCIA 11 pelo RAIO do GPS.
//
// Processo desenhado pela Isadora ("Padronização Ocorrência 11", 5 slides,
// 07/08/2026) — a verificação do raio direciona TODA a tratativa:
//
//   ATÉ 4.000 m  → ocorrência PROCEDENTE
//        Relacionamento lança 54 (aguarda retorno) → cliente manda a correção
//        (contato, CC-e ou localização) → Relacionamento lança 21 (com
//        cancelamento da reentrega) → Operação faz nova tentativa.
//
//   ACIMA DE 4.000 m → requer NOVA EVIDÊNCIA
//        Relacionamento lança 21 + CANCELA a reentrega, escrevendo no SSW
//        "BAIXA FEITA MUITO DISTANTE DO LOCAL DE ENTREGA, CORRIGIR" pra
//        Operação saber POR QUE a reentrega foi interrompida e o que corrigir
//        (Caio 07/08: a operação precisa da evidência — GPS dentro do raio).
//
// Antes desta regra o ramo >4.000 m sugeria 56 ("operação revisar"): era o
// PIOR bolsão da oc 11 — 31% de acerto (57 seguidas × 124 correções em 90d),
// contra 86% do ramo ≤4.000 m (237 × 38). O ramo de baixo NÃO muda.
//
// Sem GPS na instrução (7% dos casos de oc 11): mantém 56 conservador —
// o desenho não cobre esse caso e a decisão está pendente com a gestão.
//
// Rodar testes: deno test supabase/functions/_shared/oc11-raio-regras.test.ts
// =============================================================================

/** Limite do raio em metros. Default do processo; env OC11_GPS_THRESHOLD_METROS sobrepõe. */
export const OC11_RAIO_PADRAO_METROS = 4000;

/**
 * Texto EXATO que a Operação precisa ler no SSW quando a baixa foi feita fora
 * do raio (Caio 07/08). Vai no campo Instrução (observ, 500 chars) e, por ter
 * 56 caracteres, sobrevive inteiro ao corte de 70 do campo f6 — que é a coluna
 * "Instrução/Complemento" que o setor LÊ (mesma armadilha da NF 59299).
 * ASCII puro de propósito: o portal SSW serve iso-8859-1 e descarta silenciosamente
 * bytes UTF-8 multi-byte (NFs 2161614/156022/2282024).
 */
export const TEXTO_SSW_BAIXA_DISTANTE =
  "BAIXA FEITA MUITO DISTANTE DO LOCAL DE ENTREGA, CORRIGIR";

/** Motivo do cancelamento da reentrega registrado na ação agendada. */
export const MOTIVO_CANCELAMENTO_FORA_DO_RAIO = "BAIXA FORA DO RAIO DE ENTREGA";

export interface DecisaoOc11 {
  /** oc que o agente recomenda */
  proposta_destacada: 21 | 54 | 56;
  /** true quando a aprovação deve agendar o cancelamento da reentrega */
  cancelar_reentrega: boolean;
  /** texto que vai pro campo Instrução do SSW (null = usa a descrição padrão) */
  texto_ssw: string | null;
  /** motivo gravado na ação de cancelamento (null quando não cancela) */
  motivo_cancelamento: string | null;
  /** template de e-mail (só no ramo ≤ raio, que notifica o cliente) */
  template_email: string | null;
  gps_distancia_metros: number | null;
  gps_dentro_threshold: boolean | null;
  motivo_extraido: string | null;
  confianca: number;
  observacao_orquestrador: string;
}

/**
 * Texto do SSW pro ramo acima do raio. A FRASE VEM PRIMEIRO — o que passa de
 * 70 chars é cortado no campo que o setor lê, então a distância (contexto) vai
 * depois e a ordem é o que garante a mensagem chegar inteira.
 */
export function montarTextoSswForaDoRaio(gpsMetros: number): string {
  return `${TEXTO_SSW_BAIXA_DISTANTE} - GPS ${Math.round(gpsMetros)}M`;
}

/**
 * Decide a oc 11 pelo raio. Função PURA: recebe a distância já extraída da
 * instrução do motorista (null quando o texto não traz GPS).
 */
export function decidirOc11PeloRaio(
  gpsMetros: number | null,
  raioLimite: number = OC11_RAIO_PADRAO_METROS,
): DecisaoOc11 {
  // --- sem GPS: não dá pra validar o raio → mantém o conservador de hoje
  if (gpsMetros === null) {
    return {
      proposta_destacada: 56,
      cancelar_reentrega: false,
      texto_ssw: null,
      motivo_cancelamento: null,
      template_email: null,
      gps_distancia_metros: null,
      gps_dentro_threshold: null,
      motivo_extraido: null,
      confianca: 0.7,
      observacao_orquestrador:
        "oc=11 sem texto 'GPS (Xm)' na instrução do motorista. Sem o raio não dá pra " +
        "validar a ocorrência — sugere oc=56 pra operação revisar.",
    };
  }

  // --- ATÉ o limite: ocorrência procedente → notifica o cliente (54)
  if (gpsMetros <= raioLimite) {
    return {
      proposta_destacada: 54,
      cancelar_reentrega: false,
      texto_ssw: null,
      motivo_cancelamento: null,
      template_email: "PROBLEMAS_COM_ENDERECO",
      gps_distancia_metros: gpsMetros,
      gps_dentro_threshold: true,
      motivo_extraido: `GPS da baixa a ${gpsMetros}m do endereço (dentro de ${raioLimite}m)`,
      confianca: 0.9,
      observacao_orquestrador:
        `Raio verificado: ${gpsMetros}m (≤ ${raioLimite}m) — ocorrência PROCEDENTE. ` +
        "Sugere notificar o cliente (54) pra receber a correção do endereço; " +
        "quando ele responder, a tratativa segue pra 21 e nova tentativa.",
    };
  }

  // --- ACIMA do limite: requer nova evidência → 21 + cancela reentrega
  return {
    proposta_destacada: 21,
    cancelar_reentrega: true,
    texto_ssw: montarTextoSswForaDoRaio(gpsMetros),
    motivo_cancelamento: MOTIVO_CANCELAMENTO_FORA_DO_RAIO,
    template_email: null,
    gps_distancia_metros: gpsMetros,
    gps_dentro_threshold: false,
    motivo_extraido: `GPS da baixa a ${gpsMetros}m do endereço (>${raioLimite}m — fora do raio)`,
    confianca: 0.9,
    observacao_orquestrador:
      `Raio verificado: ${gpsMetros}m (> ${raioLimite}m) — baixa feita longe do local de ` +
      "entrega, lançamento improcedente. Sugere oc=21 CANCELANDO a reentrega e avisando " +
      "a Operação no SSW pra corrigir e gerar nova evidência antes de reprogramar.",
  };
}
