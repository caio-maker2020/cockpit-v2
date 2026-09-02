// =============================================================================
// devolucaoCteAviso — qual aviso da devolução com CT-e mostrar no card.
//
// Seletor PURO sobre os `card_events` que o backend emite (ADR 0018). Fica fora
// da tabela de prioridade do `painelDecisao` de propósito: isto é CONTEXTO
// ("talvez tenha chegado um CT-e", "chegou mais de um PDF"), não "a decisão do
// card" — a decisão é a proposta de oc 44, que renderiza na lista de ações. O
// lugar certo é o slot de avisos de contexto, que já existe.
//
// POR QUE ESTES DOIS AVISOS EXISTEM, cada um com um caso real por trás:
//
//  · TALVEZ TENHA CHEGADO (nível B) — a prova está só na conversa, nunca na
//    mensagem do anexo. A decisão nº 9 diz que aqui o agente NÃO age: avisa e a
//    MARIA confere. Caso-âncora AGV NF 8590, em que a mensagem que carrega o
//    CT-e diz apenas "Bom dia! @Gabriel Segue," e a autorização estava 8
//    mensagens / 9 dias atrás.
//
//  · VÁRIOS PDFs — o detector se recusa a adivinhar qual é o CT-e quando há
//    mais de um candidato. Anexar a NFD no lugar do CT-e é lançar documento
//    fiscal errado no SSW, e os nomes de arquivo são indistinguíveis
//    (`186900.pdf` é NFD; `60022.pdf` é CT-e).
//
// -----------------------------------------------------------------------------
// REMOVIDOS EM 2026-09-02 — e por que não voltam
// -----------------------------------------------------------------------------
// Havia mais dois avisos, `cobranca_encerrada` e `ciclo_parado`. Os dois vinham
// de eventos que SÓ o cron do vigia/cobrança emitia, e esse cron foi removido:
//
//  · a COBRANÇA saiu por decisão do Caio (2026-09-02): *"nada será cobrado de
//    maneira automática"*. Logo `DevolucaoCteEscalonadaParaHumano` não existe
//    mais — escalonar era o passo seguinte a uma cobrança que nunca sai;
//
//  · o VIGIA saiu porque não funcionava, verificado no código: (a) o cenário que
//    ele vigiava (espera da NFD via oc 56) não existe — nada escreve
//    `oc56_lancada_em`/`aguardando_nfd`/`exige_nfd`; (b) o aviso dele renderiza
//    DENTRO do painel do card, que é exatamente o card que saiu do painel da
//    operadora — trocava "linha invisível" por "banner invisível"; (c) com o
//    ciclo encerrando na oc 44 (regra do Caio: *"o caso de devolução só se
//    encerra quando a 44 é lançada"*), sua única população seria alarme falso
//    sobre devolução concluída.
//
// O teste tem um caso que prova que estes dois eventos NÃO geram aviso — é o
// guard pra decisão não voltar por engano num refactor futuro.
// =============================================================================

/** Tipos de evento que este aviso observa. A ordem aqui NÃO é a prioridade. */
export const EVENTOS_DEVOLUCAO_CTE = [
  "DevolucaoCteAnexoAmbiguo",
  "DevolucaoCteDetectada",
] as const;

export interface EventoDevolucaoCte {
  event_type: string;
  created_at: string;
  payload: Record<string, unknown> | null;
}

// Sem "urgente": o único aviso urgente era a cobrança encerrada, removida com
// a cobrança automática (Caio 2026-09-02). Tom que ninguém produz é código
// morto que o Record do banner é obrigado a carregar.
export type TomAviso = "atencao" | "info";

export interface AvisoDevolucaoCte {
  tom: TomAviso;
  titulo: string;
  detalhe: string;
  /** Identidade do aviso — usada como key e em teste. */
  tipo: "anexo_ambiguo" | "talvez_cte";
}

/**
 * Prioridade, de cima pra baixo. O primeiro que existir vence — um card mostra
 * UM aviso, não uma pilha.
 *
 * A ordem é por CUSTO DE IGNORAR, não por gravidade abstrata:
 *  1. chegou documento e o sistema não sabe qual usar (risco de lançar o
 *     documento fiscal errado no SSW);
 *  2. talvez tenha chegado (só confira).
 */
const PRIORIDADE: AvisoDevolucaoCte["tipo"][] = [
  "anexo_ambiguo",
  "talvez_cte",
];

/** Janela em que um aviso ainda é relevante. Depois disso presume-se tratado. */
export const JANELA_AVISO_MS = 15 * 24 * 60 * 60 * 1000;

function texto(p: Record<string, unknown> | null, chave: string): string {
  const v = p?.[chave];
  return typeof v === "string" ? v : "";
}

/** Converte UM evento no aviso correspondente, ou null se não gera aviso. */
function avisoDoEvento(e: EventoDevolucaoCte): AvisoDevolucaoCte | null {
  const p = e.payload ?? null;

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
