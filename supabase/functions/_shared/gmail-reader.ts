// =============================================================================
// gmail-reader — helpers pra LER do Gmail (label management, list, get, modify)
// usando OAuth do operador (mesmo refresh_token que gmail-sender usa).
//
// Uso principal: gmail-poll-inbox (cron 5min) captura respostas dos clientes
// a emails enviados pelo Cockpit. Filtro por label `cockpit-tracked` garante
// zero ruído (não pega emails pessoais da Larissa).
//
// Pré-requisito: operador deve ter scope `gmail.modify` no OAuth (set em
// oauth-gmail-start). Sem esse scope, label/list/modify retornam 403.
// =============================================================================

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const COCKPIT_LABEL_NAME = "cockpit-tracked";

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessageFull {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
  internalDate?: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: GmailPart[];
}

export interface AnexoInbound {
  /** Nome do arquivo (do Content-Disposition ou parts[].filename). */
  filename: string;
  /** MIME type (parts[].mimeType). */
  mimeType: string;
  /** ID do anexo no Gmail — necessário pra baixar via API. */
  attachmentId: string;
  /** Tamanho declarado pelo Gmail (bytes). */
  sizeBytes: number;
}

/**
 * Garante que o label `cockpit-tracked` existe na conta da operadora. Cria se
 * não existir. Retorna o ID do label (cacheado em gmail_polling_state).
 */
export async function garantirLabelCockpitTracked(
  accessToken: string,
): Promise<string> {
  // Lista labels existentes
  const list = await fetch(`${GMAIL_BASE}/labels`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!list.ok) {
    throw new Error(`Gmail labels.list HTTP ${list.status}: ${await list.text()}`);
  }
  const data = await list.json() as {
    labels?: Array<{ id: string; name: string }>;
  };
  const found = data.labels?.find((l) => l.name === COCKPIT_LABEL_NAME);
  if (found) return found.id;

  // Cria
  const create = await fetch(`${GMAIL_BASE}/labels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: COCKPIT_LABEL_NAME,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  });
  if (!create.ok) {
    throw new Error(`Gmail labels.create HTTP ${create.status}: ${await create.text()}`);
  }
  const created = await create.json() as { id: string };
  return created.id;
}

/**
 * Adiciona o label `cockpit-tracked` numa thread inteira (todas as msgs da
 * thread herdam o label). Idempotente.
 */
export async function aplicarLabelEmThread(
  accessToken: string,
  threadId: string,
  labelId: string,
): Promise<void> {
  const res = await fetch(`${GMAIL_BASE}/threads/${threadId}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
  if (!res.ok) {
    throw new Error(`Gmail threads.modify HTTP ${res.status}: ${await res.text()}`);
  }
}

/**
 * Lista mensagens não lidas no inbox da operadora nos últimos 7 dias.
 *
 * Caio 2026-05-08: tirado o filtro `label:cockpit-tracked` porque Gmail
 * NÃO propaga label aplicado via `threads.modify` pra mensagens novas que
 * chegam na thread depois — só taggeia as existentes no momento da chamada.
 * Reply do cliente que cai em thread tracked NÃO ganha o label e não era
 * capturado pelo polling. Solução: lista todas unread, filtra em memória
 * por thread_id ∈ cards_emails_outbound. Threads não-tracked são ignoradas
 * silenciosamente (sem marcar como lida) pra preservar inbox pessoal.
 */
export async function listarMensagensNaoLidas(
  accessToken: string,
): Promise<Array<{ id: string; threadId: string }>> {
  const q = `in:inbox is:unread newer_than:7d`;
  const url = `${GMAIL_BASE}/messages?q=${encodeURIComponent(q)}&maxResults=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail messages.list HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as {
    messages?: Array<{ id: string; threadId: string }>;
  };
  return data.messages ?? [];
}

/**
 * Busca payload completo de uma mensagem (headers, body, etc).
 */
export async function getMensagemFull(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageFull> {
  const url = `${GMAIL_BASE}/messages/${messageId}?format=full`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail messages.get HTTP ${res.status}: ${await res.text()}`);
  }
  return await res.json() as GmailMessageFull;
}

/**
 * Caio 2026-05-08: thread.get pra detectar respostas que a operadora mandou
 * direto pelo Gmail (fora do Cockpit). Retorna metadata mínima de cada msg
 * (id, labelIds, internalDate) — suficiente pra decidir se há SENT após
 * `cliente_respondeu_em` na thread.
 */
export interface GmailThreadMessageMin {
  id: string;
  labelIds?: string[];
  internalDate?: string;
}
export async function getThreadMin(
  accessToken: string,
  threadId: string,
): Promise<{ id: string; messages?: GmailThreadMessageMin[] }> {
  const url = `${GMAIL_BASE}/threads/${threadId}?format=minimal`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail threads.get HTTP ${res.status}: ${await res.text()}`);
  }
  return await res.json() as { id: string; messages?: GmailThreadMessageMin[] };
}

/**
 * Marca mensagem como lida (remove label UNREAD). Idempotente.
 */
export async function marcarComoLida(
  accessToken: string,
  messageId: string,
): Promise<void> {
  const res = await fetch(`${GMAIL_BASE}/messages/${messageId}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  });
  if (!res.ok) {
    throw new Error(`Gmail messages.modify HTTP ${res.status}: ${await res.text()}`);
  }
}

/**
 * Extrai header pelo nome (case-insensitive). Retorna null se não achar.
 */
export function getHeader(msg: GmailMessageFull, name: string): string | null {
  const headers = msg.payload?.headers ?? [];
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name?.toLowerCase() === lower) return h.value ?? null;
  }
  return null;
}

/**
 * Extrai corpo texto. Tenta text/plain primeiro, fallback text/html (sem
 * sanitização — front pode renderizar). Decodifica base64url.
 */
export function extrairTexto(msg: GmailMessageFull): string {
  const payload = msg.payload;
  if (!payload) return "";

  // Caso 1: corpo direto (sem partes)
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Caso 2: multipart — procura text/plain primeiro
  const parts = payload.parts ?? [];
  const plain = findPart(parts, "text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);

  const html = findPart(parts, "text/html");
  if (html?.body?.data) return decodeBase64Url(html.body.data);

  return msg.snippet ?? "";
}

function findPart(
  parts: unknown[],
  mimeType: string,
): { mimeType?: string; body?: { data?: string } } | null {
  for (const p of parts as Array<{
    mimeType?: string;
    body?: { data?: string };
    parts?: unknown[];
  }>) {
    if (p.mimeType === mimeType && p.body?.data) return p;
    if (p.parts) {
      const nested = findPart(p.parts, mimeType);
      if (nested) return nested;
    }
  }
  return null;
}

function decodeBase64Url(s: string): string {
  // Gmail retorna base64url (sem padding, com - e _)
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    return decodeURIComponent(escape(atob(padded)));
  } catch {
    try { return atob(padded); } catch { return s; }
  }
}

/**
 * Limpa angle brackets do Message-ID/In-Reply-To. Gmail às vezes retorna
 * com `<...>`, às vezes sem. Normaliza pra comparação.
 */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.trim().replace(/^<|>$/g, "");
}

/**
 * Extrai anexos de uma mensagem Gmail. Percorre `payload.parts[]` recursivo
 * e coleta parts que têm `body.attachmentId` (= é anexo separado, não inline).
 * Anexos inline (imagens cid:embed) também têm attachmentId mas geralmente
 * têm `Content-Disposition: inline` — ignoramos.
 *
 * Caio 2026-05-12 (NF 920161): cliente envia PDF do romaneio. Cockpit
 * precisa salvar o arquivo pra Larissa reusar (anexar no SSW).
 */
export function extrairAnexos(msg: GmailMessageFull): AnexoInbound[] {
  const anexos: AnexoInbound[] = [];
  const root = msg.payload;
  if (!root) return anexos;

  function visit(part: GmailPart) {
    const attachmentId = part.body?.attachmentId;
    const filename = part.filename;
    if (attachmentId && filename && filename.trim().length > 0) {
      // Filtra inline. Content-Disposition header diz "attachment" ou "inline".
      const disp = part.headers?.find(
        (h) => h.name.toLowerCase() === "content-disposition",
      )?.value?.toLowerCase() ?? "";
      const isInline = disp.startsWith("inline") && !disp.includes("attachment");
      if (!isInline) {
        anexos.push({
          filename: filename.trim(),
          mimeType: part.mimeType ?? "application/octet-stream",
          attachmentId,
          sizeBytes: part.body?.size ?? 0,
        });
      }
    }
    for (const sub of part.parts ?? []) visit(sub);
  }
  visit(root);
  return anexos;
}

/**
 * Baixa o binário de um anexo via Gmail API.
 * GET /messages/{messageId}/attachments/{attachmentId}
 * Retorna Uint8Array já decodificado de base64url.
 */
export async function baixarAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const url = `${GMAIL_BASE}/messages/${messageId}/attachments/${attachmentId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail attachments.get HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as { data?: string; size?: number };
  if (!data.data) {
    throw new Error(`Gmail attachments.get sem data field`);
  }
  // base64url → bytes
  const normalized = data.data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binStr = atob(padded);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  return bytes;
}
