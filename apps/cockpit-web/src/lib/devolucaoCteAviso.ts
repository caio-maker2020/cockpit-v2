// =============================================================================
// devolucaoCteAviso — qual aviso da devolução com CT-e mostrar no card.
//
// Seletor PURO sobre os `card_events` que o backend emite (ADR 0018). Fica fora
// da tabela de prioridade do `painelDecisao` de propósito: isto é CONTEXTO
// ("talvez tenha chegado um CT-e", "este ciclo está parado"), não "a decisão do
// card" — a decisão é a proposta de oc 44, que renderiza na lista de ações. O
// lugar certo é o slot de avisos de contexto, que já existe.
//
// POR QUE ESTES AVISOS EXISTEM, cada um com um caso real por trás:
//
//  · CICLO PARADO — a oc 56 (pedido de NFD pra unidade) manda o card pra
//    TRANSFERIDO e ele SAI do painel da MARIA. A espera dura semanas (a própria
//    thread da AGV diz "há mais de um mês"). Sem este aviso, o controle próprio
//    do ciclo só troca "card invisível" por "linha invisível".
//
//  · COBRANÇA ENCERRADA — o cliente não mandou o CT-e nem depois do lembrete.
//    A automação PARA (teto = 1) e alguém precisa saber que parou, senão o caso
//    fica esperando um robô que já desistiu.
//
//  · TALVEZ TENHA CHEGADO (nível B) — a prova está só na conversa, nunca na
//    mensagem do anexo. A decisão nº 9 diz que aqui o agente NÃO age: avisa e a
//    MARIA confere. Caso-âncora AGV NF 8590, em que a mensagem do CT-e diz
//    apenas "Bom dia! @Gabriel Segue,".
//
//  · VÁRIOS PDFs — o detector se recusa a adivinhar qual é o CT-e quando há
//    mais de um candidato. Anexar a NFD no lugar do CT-e é lançar documento
//    fiscal errado no SSW.
// =============================================================================

/** Tipos de evento que este aviso observa. A ordem aqui NÃO é a prioridade. */
export const EVENTOS_DEVOLUCAO_CTE = [
  "DevolucaoCteEscalonadaParaHumano",
  "DevolucaoCteCicloParado",
  "DevolucaoCteAnexoAmbiguo",
  "DevolucaoCteDetectada",
] as const;

export interface EventoDevolucaoCte {
  event_type: string;
  created_at: string;
  payload: Record<string, unknown> | null;
}

export type TomAviso = "urgente" | "atencao" | "info";

export interface AvisoDevolucaoCte {
  tom: TomAviso;
  titulo: string;
  detalhe: string;
  /** Identidade do aviso — usada como key e em teste. */
  tipo:
    | "cobranca_encerrada"
    | "ciclo_parado"
    | "anexo_ambiguo"
    | "talvez_cte";
}

/**
 * Prioridade, de cima pra baixo. O primeiro que existir vence — um card mostra
 * UM aviso, não uma pilha.
 *
 * A ordem é por CUSTO DE IGNORAR, não por gravidade abstrata:
 *  1. a automação desistiu (ninguém mais vai agir se o humano não agir);
 *  2. o caso está parado e possivelmente invisível;
 *  3. chegou documento e o sistema não sabe qual usar;
 *  4. talvez tenha chegado (só confira).
 */
const PRIORIDADE: AvisoDevolucaoCte["tipo"][] = [
  "cobranca_encerrada",
  "ciclo_parado",
  "anexo_ambiguo",
  "talvez_cte",
];

/** Janela em que um aviso ainda é relevante. Depois disso presume-se tratado. */
export const JANELA_AVISO_MS = 15 * 24 * 60 * 60 * 1000;

function texto(p: Record<string, unknown> | null, chave: string): string {
  const v = p?.[chave];
  return typeof v === "string" ? v : "";
}

function numero(p: Record<string, unknown> | null, chave: string): number | null {
  const v = p?.[chave];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Converte UM evento no aviso correspondente, ou null se não gera aviso. */
function avisoDoEvento(e: EventoDevolucaoCte): AvisoDevolucaoCte | null {
  const p = e.payload ?? null;

  if (e.event_type === "DevolucaoCteEscalonadaParaHumano") {
    return {
      tipo: "cobranca_encerrada",
      tom: "urgente",
      titulo: "Cobrança do CT-e encerrada — trate à mão",
      detalhe: texto(p, "aviso") ||
        "O cliente não enviou o CT-e depois do lembrete e a cobrança automática parou.",
    };
  }

  if (e.event_type === "DevolucaoCteCicloParado") {
    const dias = numero(p, "dias_uteis_parado");
    return {
      tipo: "ciclo_parado",
      tom: "atencao",
      titulo: dias != null
        ? `Devolução parada há ${dias} dia(s) útil(eis)`
        : "Devolução parada",
      detalhe: texto(p, "aviso") ||
        "O card pode estar fora do painel — confira se falta documento ou retorno da unidade.",
    };
  }

  if (e.event_type === "DevolucaoCteAnexoAmbiguo") {
    const anexos = Array.isArray(p?.["anexos"]) ? (p!["anexos"] as unknown[]) : [];
    const nomes = anexos.filter((a): a is string => typeof a === "string");
    return {
      tipo: "anexo_ambiguo",
      tom: "atencao",
      titulo: "Chegou mais de um PDF — escolha qual é o CT-e",
      detalhe: nomes.length > 0
        ? `O sistema não adivinha qual documento usar: ${nomes.join(", ")}.`
        : "O sistema não adivinha qual documento usar.",
    };
  }

  // Nível B: só sinaliza. Nunca virou proposta, de propósito (decisão nº 9).
  if (e.event_type === "DevolucaoCteDetectada" && texto(p, "acao") === "sinalizar") {
    const nome = texto(p, "anexo_escolhido_nome");
    return {
      tipo: "talvez_cte",
      tom: "info",
      titulo: "Parece ter chegado um CT-e de devolução — confira",
      detalhe: nome
        ? `A prova está em mensagem anterior da conversa, não na que trouxe "${nome}". ` +
          "Por isso o sistema avisa em vez de agir."
        : "A prova está em mensagem anterior da conversa, não na que trouxe o anexo. " +
          "Por isso o sistema avisa em vez de agir.",
    };
  }

  return null;
}

/**
 * O aviso a mostrar, ou `null`.
 *
 * @param eventos eventos do card (qualquer ordem)
 * @param agoraMs relógio, injetado pra ser testável
 */
export function escolherAvisoDevolucaoCte(
  eventos: readonly EventoDevolucaoCte[],
  agoraMs: number,
): AvisoDevolucaoCte | null {
  const candidatos = new Map<AvisoDevolucaoCte["tipo"], AvisoDevolucaoCte>();

  // Ordena por data DESC aqui dentro, e não confia na ordem do chamador: a
  // função tem de dar a mesma resposta pra qualquer ordem de entrada, senão um
  // `.order()` esquecido na query viraria aviso desatualizado sem ninguém notar.
  const ordenados = [...(eventos ?? [])]
    .map((e) => ({ e, t: Date.parse(e?.created_at ?? "") }))
    // Evento sem data confiável não decide nada — melhor não avisar que avisar
    // errado sobre um caso possivelmente antigo.
    .filter(({ t }) => Number.isFinite(t) && agoraMs - t <= JANELA_AVISO_MS)
    .sort((a, b) => b.t - a.t);

  for (const { e } of ordenados) {
    const a = avisoDoEvento(e);
    // Primeiro visto = mais recente, porque acabamos de ordenar.
    if (a && !candidatos.has(a.tipo)) candidatos.set(a.tipo, a);
  }

  for (const tipo of PRIORIDADE) {
    const a = candidatos.get(tipo);
    if (a) return a;
  }
  return null;
}
