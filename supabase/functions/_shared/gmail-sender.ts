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

export interface SendGmailParams {
  supabase: SupabaseClient;
  operadorId: string;
  destinatario: string;
  cc?: string[] | null;
  subject: string;
  texto: string;
  fromName?: string | null;
}

export type SendGmailResult =
  | { ok: true; messageId: string | null; threadId: string | null; from: string }
  | { ok: false; error: string; httpStatus?: number };

export async function sendGmailMessage(params: SendGmailParams): Promise<SendGmailResult> {
  const { supabase, operadorId, destinatario, cc, subject, texto, fromName } = params;

  if (!operadorId) return { ok: false, error: "operador_id ausente" };
  if (!destinatario) return { ok: false, error: "destinatario ausente" };
  if (!texto || !texto.trim()) return { ok: false, error: "texto vazio" };

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
  const headerLines = [
    `From: ${fromHeader}`,
    `To: ${destinatario}`,
  ];
  if (ccList.length > 0) headerLines.push(`Cc: ${ccList.join(", ")}`);
  headerLines.push(
    `Subject: ${subjectEncoded}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  );
  const headers = headerLines.join("\r\n");
  const rawMessage = `${headers}\r\n\r\n${texto}`;
  const raw = b64url(rawMessage);

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
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

  return {
    ok: true,
    messageId: (parsed?.["id"] as string | undefined) ?? null,
    threadId: (parsed?.["threadId"] as string | undefined) ?? null,
    from: fromHeader,
  };
}

async function loadOperadorGmailCreds(
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

async function refreshGmailAccessToken(
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
