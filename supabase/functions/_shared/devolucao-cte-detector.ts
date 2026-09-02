// =============================================================================
// devolucao-cte-detector — detecta o CT-e de Devolução no e-mail do cliente.
// Escopo: clientes da MARIA EDUARDA — a CARTEIRA dela, via a função de banco
// `devolucao_cte_em_escopo(cnpj_pagador)` (mig 373). Caio 2026-09-01: "todos os
// clientes da Maria seguem esse fluxo", logo NÃO existe lista de opt-in por
// cliente; escopo derivado da carteira não tem como ser ligado pro CNPJ errado.
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

// A lista de bloqueios vem do detector JÁ CALIBRADO em produção — 43 entradas,
// cada uma tirada de um falso positivo real com a NF anotada. IMPORTADA, nunca
// copiada: duas cópias divergentes da mesma decisão é a causa que o INV-042
// registra. Ver `temPedidoDeDevolucao` para o que é reusado e o que não é.
import { BLOQUEIOS } from "./email-devolucao-solicitada.ts";

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
const RE_NOME_CHAVE44 = /^\s*(\d{44})\s*\.pdf\s*$/i;

// -----------------------------------------------------------------------------
// Chave fiscal de 44 dígitos — o modelo DISTINGUE CT-e de NFD, sem abrir o PDF
// -----------------------------------------------------------------------------
//
// Layout da chave: cUF(2) AAMM(4) CNPJ(14) **mod(2)** serie(3) numero(9)
//                  tpEmis(1) cNF(8) cDV(1)
//
// Medido em 2026-09-01: as 3 amostras de NFD do Caio têm modelo **55** (NF-e) e
// as 25 chaves da caixa da MARIA no histórico têm modelo **57** (CT-e). 96 de 96
// chaves do histórico passam no dígito verificador — então a leitura da posição
// não é coincidência. Isso resolve o problema que o nome do arquivo NÃO resolve:
// `186900.pdf` (NFD) é indistinguível de `60022.pdf` (CT-e) pelo nome, e
// `LAMINA_PROTOCOLO_LEITEIRO_COMERCIAL_A4….pdf` é uma NFD com cara de folheto.

/** Modelo do documento na chave fiscal. */
export const MODELO_CTE = "57";
/** NF-e — é o que a NFD (Nota Fiscal de Devolução) é. Nunca é o CT-e. */
export const MODELO_NFE = "55";

/** Dígito verificador da chave (módulo 11, pesos 4..2 cíclicos). */
function chaveTemDvValido(digitos: string): boolean {
  const pesos = [4, 3, 2, 9, 8, 7, 6, 5];
  let soma = 0;
  for (let i = 0; i < 43; i++) {
    const d = digitos.charCodeAt(i) - 48;
    const p = pesos[i % 8];
    if (d < 0 || d > 9 || p === undefined) return false;
    soma += d * p;
  }
  const resto = soma % 11;
  const dv = resto === 0 || resto === 1 ? 0 : 11 - resto;
  return dv === digitos.charCodeAt(43) - 48;
}

/**
 * Lê a chave fiscal quando o NOME do arquivo é a chave inteira.
 * Devolve o modelo apenas se o DV fechar — chave malformada não é usada pra
 * decidir nada (cai no sinal genérico de 44 dígitos, comportamento antigo).
 */
export function chaveFiscalDoNome(
  filename: string | null | undefined,
): { chave: string; modelo: string } | null {
  const m = RE_NOME_CHAVE44.exec(filename ?? "");
  const chave = m?.[1];
  if (!chave || !chaveTemDvValido(chave)) return null;
  return { chave, modelo: chave.slice(20, 22) };
}

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

/**
 * Quebra em CLÁUSULAS: fim de frase (`.!?;`), quebra de linha **e vírgula**.
 *
 * A vírgula é o que separa decisão de pergunta dentro da MESMA frase. Sem ela o
 * caso-âncora AGV NF 8590 — *"devolução autorizada, quando podem devolver?"* —
 * seria descartado inteiro pela cerca de interrogativa, perdendo uma autorização
 * real. É exatamente onde `detectarDevolucaoSolicitada` (que corta só em `.!?;`)
 * falha neste fluxo, medido em 2026-09-01.
 */
function clausulas(textoNormalizado: string): string[] {
  return textoNormalizado
    .split(/(?<=[.!?;])\s+|\n+|,/)
    .map((c) => colapsarEspacos(c).trim())
    .filter((c) => c.length > 0);
}

/**
 * A mensagem pede/autoriza devolução? (evidência de conversa → nível B)
 *
 * HÍBRIDO (Caio 2026-09-01, medido sobre 7.258 e-mails reais): o casamento
 * positivo é o desta caixa (`RES_PEDIDO_DEVOLUCAO`), porque o fraseado da MARIA
 * — `seguir`/`seguiremos`/`prosseguir` — **não existe** em `VERBOS_COMANDO` do
 * detector de produção; mas as CERCAS são as de produção (interrogativa + a
 * lista `BLOQUEIOS`, importada, não copiada — INV-042).
 *
 * Por que não trocar tudo pelo detector de produção: ele foi calibrado na
 * população de cards de oc 10, já filtrada. Sobre inbound com PDF ele fica 62%
 * mais FROUXO no geral (173 → 281 sinais; Larissa 18→63, Victor 23→50) e ao
 * mesmo tempo mais estrito no fraseado da MARIA — perde 5 dos 8 casos-âncora,
 * incluindo o AGV NF 8590. Medição em §12 do plano.
 *
 * Resultado medido deste híbrido: 8/8 casos-âncora reconhecidos, 0/8 falsos
 * positivos (antes 3/8), nível A **inalterado** (21, todos na caixa da MARIA) e
 * o volume de avisos da MARIA praticamente igual (33 → 32). A única mensagem
 * perdida foi provada falso positivo: thread 19ff669a3194a146 (NF 47956), em que
 * o cliente disse *"estou aguardando se podemos seguir com devolução"* e depois
 * pediu **nova tentativa de entrega** — o `dacte-*.pdf` era de reentrega.
 */
export function temPedidoDeDevolucao(textoNormalizado: string): boolean {
  for (const cl of clausulas(textoNormalizado)) {
    // Pergunta não é decisão. ("vocês autorizam a devolução?")
    if (cl.includes("?")) continue;
    // Negação, hipótese, adiamento, ordem a terceiro, objeto desviado.
    if (BLOQUEIOS.some((b) => cl.includes(b))) continue;
    if (RES_PEDIDO_DEVOLUCAO.some((re) => re.test(cl))) return true;
  }
  return false;
}

/**
 * Escolhe QUAL anexo é o CT-e. Só PDFs entram.
 *
 * Ordem de decisão (a mais forte primeiro):
 *  1. **Chave fiscal com modelo 57** — prova determinística. 1 só ⇒ é esse,
 *     independente de quantos outros PDFs venham. 2+ ⇒ ambíguo.
 *  2. Chave fiscal com modelo ≠ 57 (NF-e/NFD) é **excluída** da disputa: prova
 *     determinística de que NÃO é o CT-e.
 *  3. Sinal de palavra no nome (`cte`, `dacte`, `dev`, `devolu`) entre os que
 *     sobraram — 1 só ⇒ é esse; 0 ou 2+ ⇒ ambíguo.
 *  4. 1 PDF sozinho e não excluído ⇒ é esse.
 *
 * Ambíguo devolve `null` de propósito: a Maria escolhe, nunca adivinhar. E um
 * PDF provado NF-e nunca vira "o CT-e" nem quando é o único anexo — anexar a
 * NFD no lugar do CT-e é lançar documento fiscal errado no SSW.
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

  const sinais: string[] = [];
  const cte57: number[] = [];
  const excluidos = new Set<number>();

  // (1) e (2): a chave fiscal decide, quando existe e é bem-formada.
  for (const i of pdfs) {
    const nome = lista[i]?.filename ?? "";
    const chave = chaveFiscalDoNome(nome);
    if (!chave) continue;
    if (chave.modelo === MODELO_CTE) {
      cte57.push(i);
      sinais.push(`chave44_modelo57_cte:${nome}`);
    } else {
      excluidos.add(i);
      sinais.push(
        `chave44_modelo${chave.modelo}_${chave.modelo === MODELO_NFE ? "nfe_nao_e_cte" : "nao_e_cte"}:${nome}`,
      );
    }
  }
  const unicoCte = cte57[0];
  if (cte57.length === 1 && unicoCte !== undefined) return { idx: unicoCte, sinais };
  if (cte57.length > 1) return { idx: null, sinais };

  // (3): sinal de palavra, só entre os que a chave não excluiu.
  const disputa = pdfs.filter((i) => !excluidos.has(i));
  const comSinal: number[] = [];
  for (const i of disputa) {
    const nome = lista[i]?.filename ?? "";
    if (RE_NOME_CHAVE44.test(nome)) {
      // 44 dígitos com DV inválido: sinal genérico, comportamento antigo.
      comSinal.push(i);
      sinais.push(`nome_chave_44_digitos:${nome}`);
    } else if (RE_NOME_CTE.test(nome)) {
      comSinal.push(i);
      sinais.push(`nome_cita_cte_ou_dev:${nome}`);
    }
  }
  const unicoComSinal = comSinal[0];
  if (comSinal.length === 1 && unicoComSinal !== undefined) return { idx: unicoComSinal, sinais };
  if (comSinal.length > 1) return { idx: null, sinais };

  // (4): um PDF só, sem sinal e sem exclusão.
  const unicoPdf = disputa[0];
  if (disputa.length === 1 && unicoPdf !== undefined) return { idx: unicoPdf, sinais };
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
