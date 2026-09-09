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
import { isEmailFormatoValido } from "./email-format.ts";
import { encodeSubjectRfc2047, extrairMessageIdDosHeaders } from "./email-mime.ts";

export { isEmailFormatoValido };

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
    /** Message-ID RFC 2822 REAL da mensagem enviada (sem angle brackets), lido
     * de volta do Gmail via `messages.get` logo após o send. Persistir em
     * cards_emails_outbound.message_id_header pra que o próximo email da
     * tratativa monte In-Reply-To/References que o cliente consegue resolver.
     *
     * Carlos 2026-09-09: antes a gente GERAVA `cockpit-<uuid>@...` e gravava
     * esse valor — mas o Gmail API reescreve o Message-ID no envio, então o id
     * gravado nunca existiu no fio e todo In-Reply-To montado com ele apontava
     * pro nada (Outlook do cliente abria conversa nova). `null` se a leitura de
     * volta falhar — o chamador degrada pro Message-ID do inbound do cliente. */
    messageIdHeader: string | null;
  }
  | { ok: false; error: string; httpStatus?: number };

export async function sendGmailMessage(params: SendGmailParams): Promise<SendGmailResult> {
  const { supabase, operadorId, destinatario, cc, subject, texto, fromName,
          attachments, extraHeaders, threadId, htmlBody } = params;

  if (!operadorId) return { ok: false, error: "operador_id ausente" };
  if (!destinatario) return { ok: false, error: "destinatario ausente" };
  // Guard de formato: falha clara (e acionável pelo operador) em vez do Gmail
  // 400 cru. NF 45156: nfe@vipshowroom.com.b (TLD truncado) derrubava o envio.
  if (!isEmailFormatoValido(destinatario)) {
    return {
      ok: false,
      error: `E-mail do destinatário inválido: "${destinatario.trim()}" — corrija o contato do cliente (parece truncado/digitado errado) e tente de novo.`,
    };
  }
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
  // Carlos 2026-09-09: ASCII vai cru; não-ASCII em encoded-words ≤75 chars
  // (antes era UMA word de 128+ chars, fora da RFC 2047). Preserva espaços.
  const subjectEncoded = encodeSubjectRfc2047(subject);
  // Cc é secundário: filtra os com formato inválido (best-effort) em vez de
  // derrubar o envio inteiro por causa de um Cc truncado.
  const ccList = Array.isArray(cc)
    ? cc.filter((s) => typeof s === "string" && s.trim() && isEmailFormatoValido(s))
    : [];
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
  // Carlos 2026-09-09: NÃO gerar Message-ID próprio. O Gmail reescreve esse
  // header no envio (verificado no fio: raw da cópia em Enviados traz
  // `<CA...@mail.gmail.com>`, nunca o nosso). O id real é lido de volta abaixo,
  // depois do send, e devolvido em `messageIdHeader`.
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

  async function postSend(comThreadId: boolean): Promise<{ res: Response; text: string }> {
    const sendBody: Record<string, unknown> = { raw };
    if (comThreadId && threadId) sendBody.threadId = threadId;
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sendBody),
    });
    return { res: r, text: await r.text() };
  }

  let { res, text: respText } = await postSend(true);

  // Caio 2026-06-17: o threadId é específico da CAIXA Gmail. Card reatribuído de
  // operador (reorg 2026-06-15: CARLOS/DURAFA excluídos) pode trazer um threadId
  // de OUTRA caixa → Gmail rejeita (404 "not found" / 400 "Invalid thread_id") →
  // falhava TODO envio em thread. Retry 1× SEM o threadId: o email sai como
  // thread nova na caixa atual (In-Reply-To/References preservados → cliente
  // ainda vê como resposta). Blindagem universal: cobre responder-email-cliente,
  // executor (21/44/55) e thread-por-tratativa. Âncora: NF 5558833 fortbras.
  if (threadId && !res.ok && (res.status === 404 || (res.status === 400 && /thread/i.test(respText)))) {
    console.log(
      `[gmail-sender] threadId ${threadId} rejeitado (HTTP ${res.status}) — reenviando sem threadId (provável card reatribuído de operador).`,
    );
    ({ res, text: respText } = await postSend(false));
  }

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

  // Carlos 2026-09-09: lê o Message-ID REAL que o Gmail atribuiu. Best-effort:
  // falha aqui não invalida o envio (e-mail já saiu); devolve null e o
  // chamador ancora o próximo e-mail no Message-ID do inbound do cliente.
  let messageIdHeader: string | null = null;
  if (sentMsgId) {
    try {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${sentMsgId}?format=metadata&metadataHeaders=Message-ID`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (r.ok) {
        const j = await r.json() as { payload?: { headers?: Array<{ name?: string; value?: string }> } };
        messageIdHeader = extrairMessageIdDosHeaders(j.payload?.headers);
      } else {
        console.warn(`[gmail-sender] messages.get pra Message-ID real falhou (HTTP ${r.status}); message_id_header fica null.`);
      }
    } catch (e) {
      console.warn(`[gmail-sender] messages.get pra Message-ID real lançou: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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
