// =============================================================================
// email-mime — helpers PUROS (sem rede, sem Supabase) pra montar/ler headers
// de e-mail. Fonte única usada por gmail-sender e email-threading.
//
// Por que existe (Carlos 2026-09-09, bug "resposta vira conversa nova no
// Outlook" — WURTH, NORTEL/SONEPAR, BIOMEDICAL):
//
// 1. O Gmail API REESCREVE o header Message-ID que a gente manda no raw. O id
//    `cockpit-<uuid>@salexpress.com.br` que gravávamos em
//    cards_emails_outbound.message_id_header nunca existiu no fio (prova: 0 de
//    6.933 inbounds desde 18/08 respondem a um id cockpit-; 286 carregam o id
//    só dentro de References, copiado da NOSSA cadeia). Todo In-Reply-To
//    montado com ele aponta pro nada → Exchange/Outlook do cliente não acha o
//    pai. `ehMessageIdFantasma` identifica esses ids pra que NUNCA virem âncora.
//
// 2. O Subject saía numa ÚNICA encoded-word RFC 2047 (128+ chars, limite é 75).
//    `encodeSubjectRfc2047` manda ASCII puro sem codificar e, quando precisa
//    codificar, quebra em encoded-words de até 75 chars em fronteira de
//    caractere UTF-8, dobradas com CRLF+SP. Decoders concatenam encoded-words
//    adjacentes ignorando o espaço de dobra, então NENHUM espaço do assunto
//    original se perde (espaço duplo/triplo, espaço inicial, tab).
//
// 3. `extrairMessageIdDosHeaders` lê o Message-ID REAL da resposta do
//    `messages.get` do Gmail (format=metadata) pra persistir o id que o
//    cliente de fato vai referenciar.
// =============================================================================

/** Message-ID gerado localmente por versões antigas do gmail-sender. O Gmail
 *  substitui esse header no envio, então o valor NUNCA existiu no fio. */
export const MESSAGE_ID_FANTASMA_RE = /^\s*<?\s*cockpit-/i;

export function ehMessageIdFantasma(id: string | null | undefined): boolean {
  if (!id) return false;
  return MESSAGE_ID_FANTASMA_RE.test(id);
}

/** Máximo de bytes UTF-8 por encoded-word: "=?UTF-8?B?" (10) + base64 + "?=" (2)
 *  ≤ 75 → base64 ≤ 63 chars → ≤ 47 bytes. Usa 45 (múltiplo de 3, sem padding
 *  intermediário) → base64 de 60 chars → word de 72 chars. */
const MAX_BYTES_POR_WORD = 45;

const ASCII_IMPRIMIVEL_RE = /^[\x20-\x7E]*$/;

/**
 * Codifica o Subject pra linha de header RFC 5322/2047.
 * - ASCII imprimível (sem tab/controle/não-ASCII): vai como está — máxima
 *   compatibilidade, nada a decodificar.
 * - Senão: encoded-words UTF-8/B de até 75 chars, quebradas em fronteira de
 *   caractere, dobradas com "\r\n " (CRLF + 1 espaço). Preserva TODO caractere
 *   do original, inclusive runs de espaço e espaço inicial/final.
 */
export function encodeSubjectRfc2047(subject: string): string {
  const s = subject ?? "";
  if (ASCII_IMPRIMIVEL_RE.test(s)) return s;

  const enc = new TextEncoder();
  const words: string[] = [];
  let chunk: number[] = [];
  for (const ch of s) {
    const bytes = enc.encode(ch);
    if (chunk.length + bytes.length > MAX_BYTES_POR_WORD && chunk.length > 0) {
      words.push(encodedWord(chunk));
      chunk = [];
    }
    chunk.push(...bytes);
  }
  if (chunk.length > 0) words.push(encodedWord(chunk));
  return words.join("\r\n ");
}

function encodedWord(bytes: number[]): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

/**
 * Decodifica uma linha de Subject produzida por `encodeSubjectRfc2047` (ou por
 * qualquer emissor que use só encoded-words UTF-8/B). Usado nos testes de
 * round-trip e útil pra diagnóstico; NÃO é um decoder RFC 2047 completo
 * (não trata Q-encoding nem outros charsets).
 */
export function decodeSubjectRfc2047(header: string): string {
  const unfolded = header.replace(/\r\n[ \t]/g, " ");
  if (!/=\?UTF-8\?B\?/i.test(unfolded)) return unfolded;
  // RFC 2047 §6.2: espaço entre encoded-words adjacentes é ignorado.
  const semEspacoEntreWords = unfolded.replace(/\?=\s+=\?/g, "?==?");
  const dec = new TextDecoder();
  return semEspacoEntreWords.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/gi, (_m, b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return dec.decode(bytes);
  });
}

/** Header do payload do Gmail API (`payload.headers[]`). */
export interface GmailHeaderLike {
  name?: string | null;
  value?: string | null;
}

/**
 * Message-ID real da mensagem, SEM angle brackets (convenção do banco), a
 * partir dos headers devolvidos pelo `messages.get`. Null se não vier.
 */
export function extrairMessageIdDosHeaders(
  headers: GmailHeaderLike[] | null | undefined,
): string | null {
  if (!Array.isArray(headers)) return null;
  for (const h of headers) {
    if (typeof h?.name === "string" && h.name.toLowerCase() === "message-id") {
      const v = (h.value ?? "").trim().replace(/^<|>$/g, "").trim();
      return v.length > 0 ? v : null;
    }
  }
  return null;
}
