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
// Sem GPS na instrução (Caio 08/08): MESMA saída do fora-do-raio — sem o dado
// não há evidência de que a baixa foi feita no local, então 21 + cancela
// reentrega e avisa a Operação (a evidência mínima é o GPS dentro do raio).
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

/** Motivo quando a instrução do motorista não traz GPS nenhum (Caio 08/08). */
export const MOTIVO_CANCELAMENTO_SEM_GPS = "BAIXA SEM EVIDENCIA DE GPS";

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
 * Texto do SSW quando a baixa veio SEM GPS: mesma frase-âncora (é ela que a
 * Operação reconhece), com o contexto de que faltou a evidência de GPS.
 */
export function montarTextoSswSemGps(): string {
  return `${TEXTO_SSW_BAIXA_DISTANTE} - SEM GPS NA BAIXA`;
}

/**
 * Decide a oc 11 pelo raio. Função PURA: recebe a distância já extraída da
 * instrução do motorista (null quando o texto não traz GPS).
 */
export function decidirOc11PeloRaio(
  gpsMetros: number | null,
  raioLimite: number = OC11_RAIO_PADRAO_METROS,
): DecisaoOc11 {
  // --- sem GPS: sem evidência de que a baixa foi no local → mesma saída do
  // fora-do-raio (Caio 08/08): 21 + cancela reentrega + avisa a Operação.
  if (gpsMetros === null) {
    return {
      proposta_destacada: 21,
      cancelar_reentrega: true,
      texto_ssw: montarTextoSswSemGps(),
      motivo_cancelamento: MOTIVO_CANCELAMENTO_SEM_GPS,
      template_email: null,
      gps_distancia_metros: null,
      gps_dentro_threshold: null,
      motivo_extraido: "oc=11 sem GPS na instrução do motorista — sem evidência da baixa no local",
      confianca: 0.85,
      observacao_orquestrador:
        "oc=11 sem texto 'GPS (Xm)' na instrução do motorista. Sem o GPS não há evidência " +
        "de que a baixa foi feita no local de entrega — sugere oc=21 CANCELANDO a reentrega " +
        "e avisando a Operação no SSW pra corrigir (a evidência mínima é o GPS dentro do raio).",
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
