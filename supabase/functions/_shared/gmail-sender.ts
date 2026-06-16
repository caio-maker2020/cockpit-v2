// =============================================================================
// gmail-sender — helper síncrono pra enviar email via Gmail API com OAuth do
// operador. Usado pelo executor quando precisa garantir atomicidade
// (oc=54 + email: só lança a oc se o email saiu) e pelo enviar-resposta
// (consumer da fila respostas_envio).
//
// Erros são propagados via return shape { ok: false, error } pra que o
// chamador decida o que fazer (reverter, retentar, etc).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

interface GmailCreds {
  refresh_token: string;
  email: string;
  scope?: string;
  conectado_em?: string;
  access_token_cache?: string;
  access_token_expira_em?: string;
}

export interface GmailAttachment {
  filename: string;
  mime_type: string;
  /** Base64 (não base64url) do conteúdo binário do arquivo. */
  content_base64: string;
}

export interface SendGmailParams {
  supabase: SupabaseClient;
  operadorId: string;
  destinatario: string;
  cc?: string[] | null;
  subject: string;
  texto: string;
  fromName?: string | null;
  /** Caio 2026-05-06: anexos opcionais. Quando presente, monta multipart/mixed. */
  attachments?: GmailAttachment[] | null;
  /** Headers adicionais (In-Reply-To, References pra threading). */
  extraHeaders?: Record<string, string> | null;
  /** threadId Gmail pra manter conversa. */
  threadId?: string | null;
  /** Caio 2026-05-18: HTML opcional. Quando presente, email vai como
   * multipart/alternative (text/plain fallback + text/html). Clients renderizam
   * o HTML; clients sem suporte caem no texto. Sem isso, email vai text/plain. */
  htmlBody?: string | null;
}

export type SendGmailResult =
  | {
    ok: true;
    messageId: string | null;
    threadId: string | null;
    from: string;
    /** Caio 2026-06-16: Message-ID RFC 2822 que NÓS geramos pra esta mensagem
     * (sem angle brackets). Persistir em cards_emails_outbound.message_id_header
     * pra que o próximo email da tratativa consiga montar In-Reply-To/References
     * e o Gmail anexe à mesma thread. `null` se extraHeaders já trazia Message-ID. */
    messageIdHeader: string | null;
  }
  | { ok: false; error: string; httpStatus?: number };

export async function sendGmailMessage(params: SendGmailParams): Promise<SendGmailResult> {
  const { supabase, operadorId, destinatario, cc, subject, texto, fromName,
          attachments, extraHeaders, threadId, htmlBody } = params;

  if (!operadorId) return { ok: false, error: "operador_id ausente" };
  if (!destinatario) return { ok: false, error: "destinatario ausente" };
  if (!texto || !texto.trim()) return { ok: false, error: "texto vazio" };
  const temHtml = typeof htmlBody === "string" && htmlBody.trim().length > 0;

  const creds = await loadOperadorGmailCreds(supabase, operadorId);
  if (!creds) {
    return { ok: false, error: `Operador ${operadorId} sem Gmail OAuth conectado` };
  }

  let accessToken: string;
  try {
    accessToken = await refreshGmailAccessToken(supabase, operadorId, creds);
  } catch (err) {
    return { ok: false, error: `Gmail OAuth refresh falhou: ${err instanceof Error ? err.message : String(err)}` };
  }

  const fromHeader = fromName ? `${fromName} <${creds.email}>` : creds.email;
  const subjectEncoded = `=?UTF-8?B?${b64(subject)}?=`;
  const ccList = Array.isArray(cc) ? cc.filter((s) => typeof s === "string" && s.trim()) : [];
  const anexos = (attachments ?? []).filter((a) => a.content_base64 && a.filename);
  const temAnexo = anexos.length > 0;

  const headerLines = [
    `From: ${fromHeader}`,
    `To: ${destinatario}`,
  ];
  if (ccList.length > 0) headerLines.push(`Cc: ${ccList.join(", ")}`);
  headerLines.push(`Subject: ${subjectEncoded}`);
  // Threading: In-Reply-To, References (Caio 2026-05-06)
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v) headerLines.push(`${k}: ${v}`);
    }
  }
  // Caio 2026-06-16: Message-ID próprio (sem isso o Gmail auto-gera um que a
  // gente nunca conhece, e o email seguinte da tratativa não consegue montar
  // In-Reply-To → Gmail abre thread nova). Só gera se extraHeaders não trouxe um.
  const jaTemMsgId = extraHeaders != null &&
    Object.keys(extraHeaders).some((k) => k.toLowerCase() === "message-id");
  const dominioMsgId = (creds.email.split("@")[1] ?? "salexpress.com.br").trim();
  const messageIdHeader = jaTemMsgId ? null : `cockpit-${crypto.randomUUID()}@${dominioMsgId}`;
  if (messageIdHeader) headerLines.push(`Message-ID: <${messageIdHeader}>`);
  headerLines.push("MIME-Version: 1.0");

  // Caio 2026-05-18: helper que monta o corpo (texto-only OU multipart/alternative
  // com text/plain + text/html). Usado em ambos branches (com e sem anexo).
  function montarCorpoMime(): { headerCT: string; body: string } {
    if (!temHtml) {
      return {
        headerCT: 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit',
        body: texto,
      };
    }
    const altBoundary = `alt_${crypto.randomUUID().replace(/-/g, "")}`;
    const altBody = [
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      texto,
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      htmlBody as string,
      `--${altBoundary}--`,
      "",
    ].join("\r\n");
    return {
      headerCT: `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      body: altBody,
    };
  }

  let rawMessage: string;
  if (temAnexo) {
    // Multipart/mixed com anexos. 1ª part = corpo (text-only OU alternative).
    const boundary = `cockpit_${crypto.randomUUID().replace(/-/g, "")}`;
    headerLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const corpo = montarCorpoMime();
    const parts: string[] = [
      `--${boundary}`,
      corpo.headerCT,
      "",
      corpo.body,
    ];
    // Anexos
    for (const a of anexos) {
      const filenameSafe = encodeMimeFilename(a.filename);
      // Insere quebras a cada 76 chars (RFC 2045) — Gmail aceita sem mas é boa prática
      const contentChunked = a.content_base64.replace(/(.{76})/g, "$1\r\n");
      parts.push(
        `--${boundary}`,
        `Content-Type: ${a.mime_type}; name="${filenameSafe}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${filenameSafe}"`,
        "",
        contentChunked,
      );
    }
    parts.push(`--${boundary}--`, "");

    rawMessage = `${headerLines.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
  } else {
    const corpo = montarCorpoMime();
    headerLines.push(corpo.headerCT);
    rawMessage = `${headerLines.join("\r\n")}\r\n\r\n${corpo.body}`;
  }

  const raw = b64url(rawMessage);
  const sendBody: Record<string, unknown> = { raw };
  if (threadId) sendBody.threadId = threadId;

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(sendBody),
  });
  const respText = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(respText); } catch { /* ignore */ }

  if (!res.ok) {
    return {
      ok: false,
      error: `Gmail HTTP ${res.status}: ${respText.slice(0, 300)}`,
      httpStatus: res.status,
    };
  }

  const sentMsgId = (parsed?.["id"] as string | undefined) ?? null;

  // Caio 2026-06-11: marca o próprio e-mail recém-enviado como LIDO na hora.
  // O Gmail entrega a cópia do envio via API com label UNREAD na caixa da
  // operadora — a query do gmail-poll (`is:unread`) inclusive cai nesses SENT.
  // Sem isso, todo e-mail que o Cockpit manda aparece como "não lido" pra ela
  // até o próximo poll marcar (lazy, a cada N min) → confusão "já li ou não?".
  // Toca SÓ a mensagem recém-enviada (removeLabelIds UNREAD); respostas do
  // cliente seguem chegando não-lidas normalmente. Best-effort: falha aqui
  // não invalida o envio (e-mail já saiu).
  if (sentMsgId) {
    try {
      await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${sentMsgId}/modify`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
        },
      );
    } catch (_e) {
      // best-effort — não falha o envio
    }
  }

  return {
    ok: true,
    messageId: sentMsgId,
    threadId: (parsed?.["threadId"] as string | undefined) ?? null,
    from: fromHeader,
    messageIdHeader,
  };
}

function encodeMimeFilename(name: string): string {
  // Sanitiza pra evitar quebrar header Content-Disposition.
  // Caracteres de controle e aspas viram _. Acentos passam pelo encode utf-8
  // — Gmail aceita filename UTF-8 inline.
  return name.replace(/[\r\n"\\]/g, "_").slice(0, 200);
}

export async function loadOperadorGmailCreds(
  supabase: SupabaseClient,
  operadorId: string,
): Promise<GmailCreds | null> {
  if (!operadorId) return null;
  const { data } = await supabase
    .from("operadores")
    .select("gmail_oauth_credentials")
    .eq("id", operadorId)
    .maybeSingle();
  const creds = (data as Record<string, unknown> | null)?.["gmail_oauth_credentials"] as
    | GmailCreds
    | null
    | undefined;
  if (!creds || !creds.refresh_token) return null;
  return creds;
}

export async function refreshGmailAccessToken(
  supabase: SupabaseClient,
  operadorId: string,
  creds: GmailCreds,
): Promise<string> {
  const expira = creds.access_token_expira_em ? new Date(creds.access_token_expira_em).getTime() : 0;
  if (creds.access_token_cache && expira - Date.now() > 60_000) {
    return creds.access_token_cache;
  }

  const env = Deno.env.toObject();
  const clientId = env["GOOGLE_OAUTH_CLIENT_ID"];
  const clientSecret = env["GOOGLE_OAUTH_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID/SECRET ausentes");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Gmail token refresh: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  }

  await supabase
    .from("operadores")
    .update({
      gmail_oauth_credentials: {
        ...creds,
        access_token_cache: json.access_token,
        access_token_expira_em: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
      },
    })
    .eq("id", operadorId);

  return json.access_token;
}

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

function b64url(s: string): string {
  return b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
