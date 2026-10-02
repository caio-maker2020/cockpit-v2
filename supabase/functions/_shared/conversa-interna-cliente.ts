// =============================================================================
// conversa-interna-cliente — cerca pós-LLM do interpretador (Carlos 02/10,
// relato da operadora, âncora NF 1042798 PRATI). Mesmo padrão das anti-veto
// R2–R6 (ADR 0022): o modelo LÊ, o código TRAVA.
//
// O caso (nomes fictícios): a Ana (PRATI) respondeu a todos pedindo "@Bruno [PRATI], enviar a
// evidência de erro cliente para não gerar RC; não podemos aceitar a imagem".
// Pendência INTERNA do cliente. O interpretador casou "não aceita a imagem"
// com a definição da 56 ("cliente QUESTIONOU evidência"), escreveu
// "SOLICITAR À OPERAÇÃO/EQUIPE COMERCIAL..." e a janela de veto lançou a 56
// sozinha às 08:19 de 30/09.
//
// A cerca age SÓ sobre a 56 (a classe do incidente). Dois sinais:
//   1. LEITURA DO MODELO: `pedido_dirigido_a = "outra_pessoa"` (todos os
//      pedidos/contestações do texto novo são para quem não é a Sal — colega ou
//      cliente final) + 56 → aguardar (54, ou 59 no trilho da indenização), e
//      nem esse aguardar sai sozinho (o código mudou a leitura do modelo; a
//      operadora confirma uma vez).
//   2. SINAL DETERMINÍSTICO das menções (participantes-email.
//      soMencionaQuemNaoEDaSal) — independe do modelo: o texto novo só marca
//      com "@" quem não é da Sal → a 56 fica como sugerida, mas NÃO sai sozinha.
//      Motivo: no ensaio A/B de 02/10 o modelo acertou a âncora numa rodada e
//      errou na outra; a MESMA instrução discorda de si mesma em ~12%.
//
// Tudo que não é 56 fica EXATAMENTE como hoje, sugestão e autônomo. O ensaio
// mostrou por quê: (a) "outra pessoa = nada a fazer" no prompt virava 33/44/21
// legítimos em 54 ("@Paula, segue o romaneio em anexo"; autorização no
// histórico citado — NFs 50769, 8087, 287903); (b) segurar no autônomo toda
// ação com leitura "outra_pessoa" tirava do automático 16 de 90 decisões
// legítimas ("@Rita, tratar como devolução") sem evitar erro nenhum.
//
// Campo ausente/inválido e sem menções (modelo antigo, leitura degradada,
// texto sem "@") → null → comportamento byte a byte de hoje.
// =============================================================================

export const PEDIDO_DIRIGIDO_A = ["sal_express", "outra_pessoa", "sal_e_outra_pessoa", "indefinido"] as const;
export type PedidoDirigidoA = typeof PEDIDO_DIRIGIDO_A[number];

export function normalizarPedidoDirigidoA(v: unknown): PedidoDirigidoA | null {
  return typeof v === "string" && (PEDIDO_DIRIGIDO_A as readonly string[]).includes(v)
    ? v as PedidoDirigidoA
    : null;
}

/** Marca persistida em cards.ia_sugestao_oc_resposta.conversa_interna_cliente. */
export interface MarcaConversaInterna {
  /** O MODELO leu "outra_pessoa" (telemetria; só muda algo junto com a 56). */
  detectada: boolean;
  /** oc que o modelo sugeriu e a cerca trocou por aguardar (só 56); null = não trocou. */
  rebaixou_de: number | null;
  /** quem pediu o quê a quem, nas palavras do modelo (≤150). */
  detalhe: string;
  /** Sinal determinístico: o texto novo só marca com "@" quem não é da Sal. */
  mencoes_so_fora_da_sal: boolean;
}

export interface ResultadoCercaConversaInterna {
  oc: number;
  marca: MarcaConversaInterna | null;
}

export function aplicarCercaConversaInterna(i: {
  ocSugerida: number;
  pedidoDirigidoA: PedidoDirigidoA | null;
  detalhe?: string | null;
  /** cards.cod_ultima_ocorrencia — 59 = trilho da indenização (aguardar = 59). */
  ocDoCard: number | null;
  /** soMencionaQuemNaoEDaSal() do texto novo. Ausente = false. */
  mencoesSoForaDaSal?: boolean;
}): ResultadoCercaConversaInterna {
  const detectada = i.pedidoDirigidoA === "outra_pessoa";
  const mencoes = i.mencoesSoForaDaSal === true;
  if (!detectada && !mencoes) return { oc: i.ocSugerida, marca: null };
  const detalhe = (i.detalhe ?? "").replace(/\s+/g, " ").trim().slice(0, 150);
  if (detectada && i.ocSugerida === 56) {
    return {
      oc: i.ocDoCard === 59 ? 59 : 54,
      marca: { detectada, rebaixou_de: 56, detalhe, mencoes_so_fora_da_sal: mencoes },
    };
  }
  return { oc: i.ocSugerida, marca: { detectada, rebaixou_de: null, detalhe, mencoes_so_fora_da_sal: mencoes } };
}

/** Lê a marca de `cards.ia_sugestao_oc_resposta` (jsonb). Forma inválida = null. */
export function lerMarcaConversaInterna(iaSugestao: unknown): MarcaConversaInterna | null {
  if (!iaSugestao || typeof iaSugestao !== "object") return null;
  const m = (iaSugestao as Record<string, unknown>)["conversa_interna_cliente"];
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  const detectada = o["detectada"] === true;
  const mencoes = o["mencoes_so_fora_da_sal"] === true;
  if (!detectada && !mencoes) return null;
  return {
    detectada,
    rebaixou_de: typeof o["rebaixou_de"] === "number" ? o["rebaixou_de"] as number : null,
    detalhe: typeof o["detalhe"] === "string" ? o["detalhe"] as string : "",
    mencoes_so_fora_da_sal: mencoes,
  };
}

/** A ação é uma 56 (qualquer ferramenta: lançar, lançar + e-mail)? */
export function ehAcao56(acaoKey: string | null): boolean {
  return /:56$/.test(acaoKey ?? "");
}

/**
 * A janela de veto pode armar esta ação? Só a classe do incidente é segurada:
 * - 56 rebaixada para aguardar pela leitura do modelo → nem o aguardar arma;
 * - 56 com qualquer um dos dois sinais → não arma.
 * Qualquer outra ação/leitura → false (hoje).
 */
export function conversaInternaBloqueiaVeto(
  marca: MarcaConversaInterna | null,
  acaoKey: string | null,
): boolean {
  if (!marca) return false;
  if (marca.rebaixou_de === 56) return true;
  return ehAcao56(acaoKey) && (marca.detectada || marca.mencoes_so_fora_da_sal);
}

/** A cerca mudou algo nesta leitura? Decide o card_event e o aviso no motivo. */
export function cercaConversaAgiu(marca: MarcaConversaInterna | null, ocFinal: number): boolean {
  if (!marca) return false;
  if (marca.rebaixou_de === 56) return true;
  return ocFinal === 56 && (marca.detectada || marca.mencoes_so_fora_da_sal);
}

/** Motivo didático pro banner quando a cerca agiu. */
export function motivoConversaInterna(marca: MarcaConversaInterna, operadoraNome: string): string {
  const quem = marca.detalhe ? ` (${marca.detalhe})` : "";
  if (marca.rebaixou_de != null) {
    return `Conversa INTERNA do cliente${quem} — o pedido não é para a Sal Express. ` +
      `Nada a lançar agora: manter aguardando o posicionamento do cliente. ` +
      `[IA havia sugerido oc ${marca.rebaixou_de}; ${operadoraNome} confirma antes — não sai sozinho.]`;
  }
  return `O texto novo só marca com "@" pessoas de fora da Sal — confira se o pedido é mesmo para a Sal ` +
    `antes de lançar: a 56 não sai sozinha.`;
}
