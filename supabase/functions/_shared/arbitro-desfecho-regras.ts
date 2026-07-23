// =============================================================================
// arbitro-desfecho-regras.ts — regras PURAS do Árbitro de Desfecho T+7 (F3).
//
// Spec D1: divergência operador×IA é julgada pelo que ACONTECEU com o card,
// não por opinião. Conservador por desenho: só afirma confirma_ia /
// confirma_operador quando o card resolveu limpo; o resto é inconclusivo.
//
// Fontes: estado atual do card + eventos pós-decisão (banco). ZERO SSW novo.
// Rodar testes: deno test supabase/functions/_shared/arbitro-desfecho-regras.test.ts
// =============================================================================

export interface ParPraArbitrar {
  veredito: string; // seguida | corrigida | rejeitada | abstencao | nao_rodou
  oc_sugerida: number | null;
  oc_executada: number | null;
}

export interface EstadoCard {
  state: string | null;
  cod_ultima_ocorrencia: number | null;
}

export interface EventoPosDecisao {
  event_type: string;
  created_at: string;
}

export interface DesfechoClassificado {
  desfecho:
    | "resolvido_limpo"
    | "reaberto"
    | "bounce"
    | "oc_nova"
    | "em_aberto"
    | "indefinido";
  arbitro: "confirma_ia" | "confirma_operador" | "inconclusivo";
  sinais: Record<string, unknown>;
}

/** Eventos que significam "o card voltou" (tratativa não fechou de verdade). */
const EVENTOS_REABERTURA = new Set(["BastaoReabriuNFFonteRelacionamento"]);
/** E-mail voltou — só relevante quando a ação do par envolvia notificar (54). */
const EVENTO_BOUNCE = "BounceDetectado";

const ESTADOS_FECHADOS = new Set(["RESOLVIDO", "CANCELADO"]);

export function classificarDesfecho(
  par: ParPraArbitrar,
  card: EstadoCard | null,
  eventosPosDecisao: EventoPosDecisao[],
): DesfechoClassificado {
  if (!card) {
    return {
      desfecho: "indefinido",
      arbitro: "inconclusivo",
      sinais: { motivo: "card não encontrado" },
    };
  }

  // A oc que valeu no fim: a executada (correção) ou a sugerida (seguida)
  const ocFinal = par.oc_executada ?? par.oc_sugerida;

  const reaberturas = eventosPosDecisao.filter((e) =>
    EVENTOS_REABERTURA.has(e.event_type)
  );
  const bounces = eventosPosDecisao.filter(
    (e) => e.event_type === EVENTO_BOUNCE,
  );
  const bounceRelevante = bounces.length > 0 && ocFinal === 54;

  const sinais: Record<string, unknown> = {
    oc_final: ocFinal,
    reaberturas: reaberturas.length,
    bounces: bounces.length,
    estado: card.state,
    cod_ultima: card.cod_ultima_ocorrencia,
  };

  let desfecho: DesfechoClassificado["desfecho"];
  if (reaberturas.length > 0) {
    desfecho = "reaberto";
  } else if (bounceRelevante) {
    desfecho = "bounce";
  } else if (ESTADOS_FECHADOS.has(card.state ?? "")) {
    desfecho = "resolvido_limpo";
  } else if (
    ocFinal !== null &&
    card.cod_ultima_ocorrencia !== null &&
    card.cod_ultima_ocorrencia !== ocFinal
  ) {
    // a tratativa continuou por outra ocorrência depois da ação do par
    desfecho = "oc_nova";
  } else {
    desfecho = "em_aberto";
  }

  // Árbitro conservador: só cravar com resolução limpa.
  let arbitro: DesfechoClassificado["arbitro"] = "inconclusivo";
  if (desfecho === "resolvido_limpo") {
    if (par.veredito === "seguida") arbitro = "confirma_ia";
    else if (par.veredito === "corrigida" || par.veredito === "rejeitada") {
      arbitro = "confirma_operador";
    }
    // abstencao/nao_rodou → inconclusivo (não há decisão da IA pra confirmar)
  }

  return { desfecho, arbitro, sinais };
}
