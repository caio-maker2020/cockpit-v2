// email-teste-gmail-oauth — função AD-HOC pra testar envio via Gmail API
// usando OAuth da Larissa. Pode deletar depois.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

Deno.serve(async (req) => {
  try {
    const env = Deno.env.toObject();
    const body = await req.json().catch(() => ({}));
    const operadorNome = body.operador_nome ?? "LARISSA";
    const to = body.to ?? "caio@salexpress.com.br";

    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // 1. Carrega creds
    const { data: op } = await supabase
      .from("operadores")
      .select("id, nome, gmail_oauth_credentials")
      .eq("nome", operadorNome)
      .maybeSingle();
    if (!op?.gmail_oauth_credentials) {
      return Response.json({ ok: false, error: `${operadorNome} sem gmail_oauth_credentials` }, { status: 404 });
    }

    const creds = op.gmail_oauth_credentials as {
      refresh_token: string;
      email: string;
      access_token_cache?: string;
      access_token_expira_em?: string;
    };

    // 2. Refresh access_token (mesma lógica do enviar-resposta)
    const expira = creds.access_token_expira_em ? new Date(creds.access_token_expira_em).getTime() : 0;
    let accessToken = creds.access_token_cache;
    if (!accessToken || expira - Date.now() < 60_000) {
      const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env["GOOGLE_OAUTH_CLIENT_ID"]!,
          client_secret: env["GOOGLE_OAUTH_CLIENT_SECRET"]!,
          refresh_token: creds.refresh_token,
          grant_type: "refresh_token",
        }),
      });
      const refreshJson = await refreshRes.json();
      if (!refreshRes.ok) {
        return Response.json({
          ok: false,
          step: "refresh_token",
          status: refreshRes.status,
          err: refreshJson,
        }, { status: 500 });
      }
      accessToken = refreshJson.access_token;
      // Atualiza cache
      await supabase
        .from("operadores")
        .update({
          gmail_oauth_credentials: {
            ...creds,
            access_token_cache: accessToken,
            access_token_expira_em: new Date(Date.now() + (refreshJson.expires_in ?? 3600) * 1000).toISOString(),
          },
        })
        .eq("id", op.id);
    }

    // 3. Compose RFC 2822
    const fromHeader = `LARISSA <${creds.email}>`;
    const subject = "[Teste Cockpit] Validação Gmail OAuth — sem spam";
    const textBody = [
      "Olá Caio,",
      "",
      "Esse é um email teste enviado direto da inbox da Larissa via Gmail API + OAuth.",
      "",
      "Se chegar na sua inbox normal (NÃO no spam), confirma que a integração tá 100%.",
      "",
      "Próximo passo: ligar isso no fluxo real (oc=11/10/35) e go-live.",
      "",
      "—",
      "Cockpit Sal Express (teste interno · " + new Date().toISOString().slice(0, 16).replace("T", " ") + ")",
    ].join("\n");

    const subjectEncoded = `=?UTF-8?B?${b64(subject)}?=`;
    const headers = [
      `From: ${fromHeader}`,
      `To: ${to}`,
      `Subject: ${subjectEncoded}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
    ].join("\r\n");
    const rawMessage = `${headers}\r\n\r\n${textBody}`;
    const raw = b64url(rawMessage);

    // 4. Send via Gmail API
    const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });
    const sendJson = await sendRes.json();

    return Response.json({
      ok: sendRes.ok,
      status: sendRes.status,
      gmail_response: sendJson,
      from: creds.email,
      to,
      subject,
    }, { status: sendRes.ok ? 200 : 500 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
});

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64url(s: string): string {
  return b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
