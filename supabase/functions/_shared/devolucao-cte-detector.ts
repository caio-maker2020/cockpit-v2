// =============================================================================
// devolucao-cte-detector — detecta o CT-e de Devolução no e-mail do cliente.
// Escopo: clientes da MARIA EDUARDA com cliente_config.exige_cte_devolucao.
//
// Decisão do Caio 2026-09-01 (calibrado em 3 e-mails REAIS + 1 do vídeo):
// a evidência de que o PDF anexo é um CT-e de Devolução vem do E-MAIL, não do
// documento. Medido: só 2 de 5 CT-e trazem marcador no corpo do PDF, e a regra
// de inversão origem/destino FALHA no caso AGV. Não existe extração de texto de
// PDF no repo — então o e-mail é a única porta.
//
// DOIS NÍVEIS (decisão nº 9 — o agente nunca age com evidência fraca):
//   NÍVEL A — a frase de entrega está na PRÓPRIA mensagem do anexo
//             ("Em anexo Cte de devolução" / "Segue CTE de devolução")
//             → monta a proposta de oc 44 com o anexo.
//   NÍVEL B — a prova está só em mensagem ANTERIOR da conversa
//             ("devolução autorizada", "prosseguir com a devolução")
//             → APENAS sinaliza no card. NUNCA monta ação.
//
// Casos-âncora (fixtures do teste):
//   A · Dellas NF 195392  — "Favor prosseguir com a devolução... Em anexo Cte
//       de devolução."                            → anexo `CTE DEV. NF 195392.pdf`
//   A · Ícaro  NF 10570314 — "Seguir com devolução da NF em assunto, foi
//       recusada pelo cliente. Segue CTE de devolução." → `dacte-55657992.pdf`
//   B · AGV    NF 8590     — a mensagem do anexo diz SÓ "Bom dia! @Gabriel
//       Segue,". A prova ("devolução autorizada, quando podem devolver?") está
//       8 mensagens e 9 dias antes. Anexo: chave fiscal de 44 dígitos como nome.
//       A AGV tem cadeia interna (Pré CT-e → aprova custo → emite) e quem manda
//       o arquivo é um administrativo que não repete o contexto.
// =============================================================================

/** Anexo como o Cockpit já o guarda (email_anexos / AnexoInbound). */
export interface AnexoDetector {
  filename: string;
  mimeType: string;
}

export interface MensagemDetector {
  /** Corpo em texto puro. */
  corpo: string;
  /** Assunto (pode repetir a NF). */
  assunto?: string | null;
  /** Remetente. Interno/robô nunca dispara. */
  remetente?: string | null;
  anexos?: AnexoDetector[];
}

export type NivelDeteccao = "A" | "B";

export interface ResultadoDetector {
  /** null = não é candidato a CT-e de devolução. */
  nivel: NivelDeteccao | null;
  /** Índice do anexo escolhido em `mensagem.anexos`, ou null se ambíguo/ausente. */
  idxAnexo: number | null;
  /** Por que decidiu assim — vai pro card_event, é o que a Maria lê. */
  motivos: string[];
  /** Sinais do NOME do arquivo (corroboram, nunca abrem porta sozinhos). */
  sinaisNome: string[];
}

// -----------------------------------------------------------------------------
// Fail-closed: quem NUNCA dispara o detector
// -----------------------------------------------------------------------------

/** Domínio próprio + domínios SSW (espelha _shared/remetente-autorizado.ts). */
const DOMINIOS_NAO_CLIENTE = [
  "salexpress.com.br",
  "ssw.inf.br",
  "ssw.com.br",
  "sswonline.com.br",
];

/** Prefixos de robô (espelha PREFIXOS_BLOCKED do remetente-autorizado). */
const PREFIXOS_ROBO = [
  "noreply@",
  "no-reply@",
  "notifications@",
  "notificacao@",
  "automatico@",
  "automatic@",
  "do-not-reply@",
];

export function ehRemetenteQueDispara(remetente: string | null | undefined): boolean {
  const e = (remetente ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  if (DOMINIOS_NAO_CLIENTE.some((d) => e.endsWith("@" + d) || e.endsWith("." + d))) return false;
  if (PREFIXOS_ROBO.some((p) => e.startsWith(p))) return false;
  return true;
}

// -----------------------------------------------------------------------------
// Normalização do texto
// -----------------------------------------------------------------------------

/** Remove acento e baixa a caixa — o cliente escreve "devolucao", "Devolução", "DEVOLUÇÃO". */
export function normalizar(txt: string | null | undefined): string {
  return (txt ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Colapsa quebra de linha e espaço repetido num único espaço.
 *
 * OBRIGATÓRIO antes de casar as frases. Medido no histórico real (2026-09-01):
 * o corpo do e-mail vem quebrado em ~78 colunas e a quebra cai NO MEIO da
 * frase. Caso-âncora `CTE DEV. NF 196128.pdf` (Dellas, 26/08): o corpo é
 * literalmente `"Segue Cte de\ndevolução ."` — as regex de entrega usam a
 * janela `[^.\n!?]{0,40}`, que não atravessa `\n`, e o CT-e era ignorado com
 * motivo `pdf_sem_evidencia_de_devolucao`.
 *
 * Só é seguro DEPOIS de `apenasFalaNova`, que é linha-a-linha e precisa dos
 * `\n` pra cortar citação e bloco de encaminhamento.
 */
export function colapsarEspacos(txt: string | null | undefined): string {
  return (txt ?? "").replace(/\s+/g, " ");
}

/**
 * Tira o que NÃO é fala nova do remetente: linhas citadas (`> ...`), o bloco de
 * encaminhamento do Outlook/Gmail (`De:`/`Enviado:`/`Para:`/`Assunto:` e tudo
 * depois) e o marcador do Gmail de histórico oculto.
 * Sem isso, um "Em anexo Cte de devolução" citado de 3 semanas atrás
 * re-disparava o detector a cada resposta da thread.
 */
export function apenasFalaNova(corpo: string | null | undefined): string {
  const linhas = (corpo ?? "").split(/\r?\n/);
  const mantidas: string[] = [];
  for (const linhaRaw of linhas) {
    const linha = linhaRaw ?? "";
    const n = normalizar(linha).trim();
    if (n.startsWith(">")) continue;
    if (/^(de|from|enviado|sent|para|to|cc|cco|bcc|assunto|subject)\s*:/.test(n)) break;
    if (n.includes("texto das mensagens anteriores oculto")) break;
    if (/^-{2,}\s*(mensagem|forwarded|original)/.test(n)) break;
    mantidas.push(linha);
  }
  return mantidas.join("\n");
}

// -----------------------------------------------------------------------------
// Padrões — todos extraídos de e-mails REAIS (não inventados)
// -----------------------------------------------------------------------------

const CTE = String.raw`(?:ct\s*-?\s*e|cte|dacte)`;

/**
 * ENTREGA do documento: verbo de entrega + CT-e + "devolu" numa janela curta.
 * Reais: "Em anexo Cte de devolução", "Segue CTE de devolução",
 *        "Segue Cte de devolução."
 * NÃO casa (de propósito): "poderiam emitir o CT-e de Devolução abaixo?" —
 * é PEDIDO pra Sal Express emitir, não entrega. Não há verbo de entrega.
 */
const RE_ENTREGA_CTE = new RegExp(
  String.raw`\b(em\s+anexo|anexo|anexa(?:do|da|mos)|segue(?:m|\s+em\s+anexo)?|encaminho|envio|enviando|vai\s+em\s+anexo)\b` +
    String.raw`[^.\n!?]{0,40}\b${CTE}\b[^.\n!?]{0,40}\bdevolu`,
  "i",
);

/** Mesma ideia, ordem invertida: "CT-e de devolução em anexo". */
const RE_ENTREGA_CTE_INVERSA = new RegExp(
  String.raw`\b${CTE}\b[^.\n!?]{0,40}\bdevolu\w*[^.\n!?]{0,40}\b(em\s+anexo|anexo|segue|anexa(?:do|da))\b`,
  "i",
);

/**
 * Terceira ordem, medida no histórico real: "devolução" ANTES do verbo e do
 * CT-e. Caso-âncora `60113.pdf` (AGV, 31/08): *"Seguiremos com devolução,
 * segue anexo CT-e, poderiam nos informar previsão de retorno?"* — os dois
 * padrões acima exigem CT-e antes de `devolu` (ou vice-versa com o verbo no
 * fim) e ignoravam este.
 *
 * A janela `[^.!?]{0,40}` NÃO atravessa fim de frase, e isso é o que segura o
 * caso interrogativo: em *"seguir com os processos de devolução. Por gentileza,
 * poderiam emitir o CT-e de Devolução abaixo?"* o ponto depois de `devolução`
 * corta — pedido continua nível B, nunca A.
 */
const RE_ENTREGA_CTE_DEVOLU_PRIMEIRO = new RegExp(
  String.raw`\bdevolu\w*[^.\n!?]{0,40}\b(em\s+anexo|anexo|anexa(?:do|da|mos)|segue(?:m)?|encaminho|envio|enviando)\b` +
    String.raw`[^.\n!?]{0,40}\b${CTE}\b`,
  "i",
);

/**
 * PEDIDO/AUTORIZAÇÃO de devolução — evidência de CONVERSA (nível B).
 * Reais: "Favor prosseguir com a devolução", "Seguir com devolução da NF",
 *        "devolução autorizada, quando podem devolver?",
 *        "seguir com os processos de devolução".
 */
const RES_PEDIDO_DEVOLUCAO: RegExp[] = [
  /\bprosseguir\s+com\s+(?:a\s+)?devolu/i,
  // "seguiremos" é forma real medida no histórico (AGV 31/08, `60113.pdf`).
  /\bsegu(?:ir|iremos|imos)\s+com\s+(?:a\s+|o\s+|os\s+)?(?:processos?\s+de\s+)?devolu/i,
  /\bdevolu\w*\s+autorizad/i,
  /\bautoriz\w+[^.\n]{0,30}\bdevolu/i,
  /\bpode[m]?\s+devolver\b/i,
  /\bquando\s+pode[m]?\s+devolver\b/i,
  /\bretornar\s+com\s+as\s+mercadorias\b/i,
];

/** Sinais no NOME do arquivo. Corroboram; nunca abrem porta sozinhos. */
const RE_NOME_CTE = /(?:\bct-?e\b|dacte|\bdev\b|devolu)/i;
/** Nome que é uma chave fiscal de 44 dígitos (caso AGV — sem palavra nenhuma). */
const RE_NOME_CHAVE44 = /^\s*\d{44}\s*\.pdf\s*$/i;

function ehPdf(a: AnexoDetector): boolean {
  const mime = (a.mimeType ?? "").toLowerCase();
  const nome = (a.filename ?? "").toLowerCase();
  return mime === "application/pdf" || nome.endsWith(".pdf");
}

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

/**
 * A mensagem entrega o documento? (texto já normalizado e sem citação)
 * Colapsa espaço aqui dentro: a quebra de linha do corpo do e-mail cai no meio
 * da frase e as janelas das regex não atravessam `\n`. Ver `colapsarEspacos`.
 */
export function temFraseDeEntrega(textoNormalizado: string): boolean {
  const t = colapsarEspacos(textoNormalizado);
  return RE_ENTREGA_CTE.test(t) ||
    RE_ENTREGA_CTE_INVERSA.test(t) ||
    RE_ENTREGA_CTE_DEVOLU_PRIMEIRO.test(t);
}

/** A mensagem pede/autoriza devolução? (evidência de conversa) */
export function temPedidoDeDevolucao(textoNormalizado: string): boolean {
  const t = colapsarEspacos(textoNormalizado);
  return RES_PEDIDO_DEVOLUCAO.some((re) => re.test(t));
}

/**
 * Escolhe QUAL anexo é o CT-e. Só PDFs entram.
 *  - 1 PDF                      → esse
 *  - vários, 1 com sinal de nome → esse
 *  - vários, 0 ou 2+ com sinal   → null (ambíguo: a Maria escolhe, nunca adivinhar)
 */
export function escolherAnexoCte(
  anexos: AnexoDetector[] | undefined,
): { idx: number | null; sinais: string[] } {
  const lista = anexos ?? [];
  const pdfs: number[] = [];
  for (let i = 0; i < lista.length; i++) {
    const a = lista[i];
    if (a && ehPdf(a)) pdfs.push(i);
  }
  if (pdfs.length === 0) return { idx: null, sinais: [] };

  const comSinal: number[] = [];
  const sinais: string[] = [];
  for (const i of pdfs) {
    const nome = lista[i]?.filename ?? "";
    if (RE_NOME_CHAVE44.test(nome)) {
      comSinal.push(i);
      sinais.push(`nome_chave_44_digitos:${nome}`);
    } else if (RE_NOME_CTE.test(nome)) {
      comSinal.push(i);
      sinais.push(`nome_cita_cte_ou_dev:${nome}`);
    }
  }
  const primeiroPdf = pdfs[0];
  if (pdfs.length === 1 && primeiroPdf !== undefined) return { idx: primeiroPdf, sinais };
  const unicoComSinal = comSinal[0];
  if (comSinal.length === 1 && unicoComSinal !== undefined) return { idx: unicoComSinal, sinais };
  return { idx: null, sinais };
}

/**
 * Decide o nível.
 * @param mensagem      a mensagem que TROUXE o anexo
 * @param corposAnteriores corpos das mensagens ANTERIORES da mesma conversa
 */
export function detectarCteDevolucao(
  mensagem: MensagemDetector,
  corposAnteriores: string[] = [],
): ResultadoDetector {
  const motivos: string[] = [];

  if (!ehRemetenteQueDispara(mensagem.remetente)) {
    return {
      nivel: null,
      idxAnexo: null,
      motivos: [`remetente_nao_dispara:${mensagem.remetente ?? "(vazio)"}`],
      sinaisNome: [],
    };
  }

  const { idx, sinais } = escolherAnexoCte(mensagem.anexos);
  const temPdf = (mensagem.anexos ?? []).some((a) => a && ehPdf(a));
  if (!temPdf) {
    return { nivel: null, idxAnexo: null, motivos: ["sem_anexo_pdf"], sinaisNome: sinais };
  }

  const textoProprio = normalizar(
    `${mensagem.assunto ?? ""}\n${apenasFalaNova(mensagem.corpo)}`,
  );

  if (temFraseDeEntrega(textoProprio)) {
    motivos.push("frase_de_entrega_na_propria_mensagem");
    return { nivel: "A", idxAnexo: idx, motivos: [...motivos, ...sinais], sinaisNome: sinais };
  }

  // Pedido/autorização de devolução vale como evidência de CONVERSA tanto na
  // PRÓPRIA mensagem quanto em anterior. Na própria: o cliente diz "prosseguir
  // com a devolução" e anexa um PDF, mas NÃO diz que o PDF é o CT-e — pode ser
  // NFD, foto ou comprovante. Evidência real, porém indireta ⇒ nível B (só
  // sinaliza), nunca A. Ver decisão nº 9.
  if (temPedidoDeDevolucao(textoProprio)) {
    motivos.push("pedido_de_devolucao_na_propria_mensagem_sem_dizer_que_o_anexo_e_o_cte");
    return { nivel: "B", idxAnexo: idx, motivos: [...motivos, ...sinais], sinaisNome: sinais };
  }

  const houvePedidoAntes = corposAnteriores.some((c) =>
    temPedidoDeDevolucao(normalizar(apenasFalaNova(c))),
  );
  if (houvePedidoAntes) {
    motivos.push("pedido_de_devolucao_em_mensagem_anterior");
    // Nível B NUNCA monta ação — só sinaliza. Ver decisão nº 9.
    return { nivel: "B", idxAnexo: idx, motivos: [...motivos, ...sinais], sinaisNome: sinais };
  }

  return {
    nivel: null,
    idxAnexo: null,
    motivos: ["pdf_sem_evidencia_de_devolucao"],
    sinaisNome: sinais,
  };
}
