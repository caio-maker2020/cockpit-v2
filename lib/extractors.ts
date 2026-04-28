/**
 * Extratores puros de campos a partir de texto livre de mensagens
 * (WhatsApp / e-mail) e normalização de números BR.
 *
 * Origem: regex calibradas em produção no v1 (edge-functions/webhook).
 * Mantemos os padrões para preservar o baseline de extração já medido.
 */

const NF_LABELED = /(?:nf|nota\s*(?:fiscal)?)\s*:?\s*#?\s*(\d{4,})/gi;
const NF_STANDALONE = /\b(\d{5,8})\b/g;
const CTRC_PATTERN =
  /(?:ct(?:e|rc|r)?(?:\s*-?\s*e)?)\s*:?\s*#?\s*([A-Z]*\d{4,}[\-\d A-Z]*)/gi;
const EMAIL_DOMAIN_PATTERN = /@([a-zA-Z0-9.-]+)/;

/**
 * Extrai NFs do texto. Estratégia em duas fases:
 *  1. NFs rotuladas ("NF 12345", "nota fiscal: 12345") — confiável.
 *  2. Fallback: números soltos de 5–8 dígitos (mais ruidoso, só se 1 não achou).
 *
 * Sempre tira zeros à esquerda e deduplica preservando ordem.
 */
export function extractNFs(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(NF_LABELED)) {
    const raw = m[1];
    if (!raw) continue;
    const nf = raw.replace(/^0+/, "");
    if (nf && !seen.has(nf)) {
      seen.add(nf);
      out.push(nf);
    }
  }

  if (out.length === 0) {
    for (const m of text.matchAll(NF_STANDALONE)) {
      const raw = m[1];
      if (!raw) continue;
      const nf = raw.replace(/^0+/, "");
      if (nf && !seen.has(nf)) {
        seen.add(nf);
        out.push(nf);
      }
    }
  }

  return out;
}

/**
 * Extrai CTRCs / CT-e do texto. Padrão tolerante a variações:
 * "CTRC", "CT-e", "CTE", "CT", "CTR", com ou sem `:` e `#`.
 */
export function extractCTRCs(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(CTRC_PATTERN)) {
    const raw = m[1];
    if (!raw) continue;
    const ctrc = raw.trim();
    if (ctrc && !seen.has(ctrc)) {
      seen.add(ctrc);
      out.push(ctrc);
    }
  }

  return out;
}

/**
 * Domínio em lowercase a partir de um e-mail. Retorna `null` se não houver `@`
 * ou se o domínio estiver vazio.
 */
export function extractEmailDomain(email: string): string | null {
  const m = email.match(EMAIL_DOMAIN_PATTERN);
  if (!m) return null;
  const domain = m[1];
  if (!domain) return null;
  return domain.toLowerCase();
}

/**
 * Base do domínio (parte antes do TLD). Útil pra match heurístico contra
 * `pagador` no v1: `samsung.com.br` → `samsung`.
 */
export function extractEmailDomainBase(email: string): string | null {
  const domain = extractEmailDomain(email);
  if (!domain) return null;
  return domain.replace(/\.(com|com\.br|net|org)(\..+)?$/, "");
}

/**
 * Corrige número de celular brasileiro adicionando o 9º dígito
 * quando ausente (regra Anatel pós-2014).
 *
 * Aplica APENAS se a entrada já estiver no formato `55 + DDD(2) + 8 dígitos`
 * (12 caracteres). Em qualquer outro formato (já com 9, internacional fora
 * do BR, fixo, etc.) retorna intacto — silêncio é seguro aqui.
 */
export function fixBrazilianMobile(phone: string): string {
  if (/^55\d{10}$/.test(phone)) {
    return phone.slice(0, 4) + "9" + phone.slice(4);
  }
  return phone;
}

/**
 * Limpa um JID do WhatsApp removendo sufixos `@s.whatsapp.net` e `@g.us`.
 * Retorna `{ number, isGroup }` para o caller decidir o que fazer.
 */
export function parseWhatsappJid(jid: string): {
  number: string;
  isGroup: boolean;
} {
  const isGroup = /@g\.us$/.test(jid);
  const number = jid
    .replace(/@s\.whatsapp\.net$/, "")
    .replace(/@g\.us$/, "");
  return { number, isGroup };
}
