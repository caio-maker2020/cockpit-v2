// =============================================================================
// oauth-gmail-callback (Vercel Edge)
//
// Recebe redirect do Google após operadora autorizar OAuth Gmail. Hospedado
// no Vercel pq Supabase Edge Functions forçam text/plain (não serve HTML).
//
// Fluxo:
// 1. Lê ?code=...&state=... da URL
// 2. Valida state via Supabase REST (oauth_pending_states existe + não expirou)
// 3. Troca code por tokens via https://oauth2.googleapis.com/token
// 4. Busca email do user Google
// 5. Salva refresh_token em operadores.gmail_oauth_credentials
// 6. Deleta state usado
// 7. Retorna página HTML de sucesso
// =============================================================================

export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return errorPage("Autorização recusada", `Google retornou erro: ${errorParam}`);
  }
  if (!code || !state) {
    return errorPage("Link inválido", "Faltam parâmetros obrigatórios (code, state).");
  }

  const supabaseUrl = process.env.SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;

  if (!supabaseUrl || !serviceKey || !clientId || !clientSecret) {
    return errorPage("Configuração", "Env vars do servidor incompletas.");
  }

  const supaHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };

  // 1. Valida state
  const stateRes = await fetch(
    `${supabaseUrl}/rest/v1/oauth_pending_states?state=eq.${encodeURIComponent(state)}&select=state,user_id,expira_em`,
    { headers: supaHeaders },
  );
  const stateRows = (await stateRes.json()) as Array<{ state: string; user_id: string; expira_em: string }>;
  const stateRow = stateRows[0];

  if (!stateRow) {
    return errorPage("Link inválido ou expirado", "State não encontrado. Inicie o OAuth novamente pelo Cockpit.");
  }
  if (new Date(stateRow.expira_em) < new Date()) {
    await fetch(`${supabaseUrl}/rest/v1/oauth_pending_states?state=eq.${encodeURIComponent(state)}`, {
      method: "DELETE",
      headers: supaHeaders,
    });
    return errorPage("Link expirado", "Esse link expirou (10min). Inicie o OAuth novamente.");
  }

  // 2. Troca code por tokens (redirect_uri DEVE bater EXATAMENTE com o configurado no GCP)
  const redirectUri = "https://cockpit-r-evidencia.vercel.app/api/oauth-gmail-callback";
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenJson = (await tokenRes.json()) as {
    refresh_token?: string;
    access_token?: string;
    scope?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!tokenRes.ok) {
    return errorPage(
      "Erro na autorização",
      `Google rejeitou a troca de tokens: ${tokenJson.error_description ?? tokenJson.error ?? "erro desconhecido"}`,
    );
  }

  if (!tokenJson.refresh_token) {
    return errorPage(
      "Refresh token ausente",
      "Google não retornou refresh_token. Vá em myaccount.google.com → Segurança → Apps com acesso, remova 'Cockpit Sal Express' e tente conectar de novo.",
    );
  }

  // 3. Busca email do user Google
  const userInfoRes = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${tokenJson.access_token}` } },
  );
  const userInfo = (await userInfoRes.json()) as { email?: string; name?: string };
  const gmailEmail = userInfo.email;

  if (!gmailEmail) {
    return errorPage("Erro ao identificar conta", "Não conseguimos obter o email da conta Google autorizada.");
  }

  // 4. Mapeia user_id → operador
  const opRes = await fetch(
    `${supabaseUrl}/rest/v1/operadores?user_id=eq.${stateRow.user_id}&select=id,nome,email_relacionamento`,
    { headers: supaHeaders },
  );
  const operadores = (await opRes.json()) as Array<{ id: string; nome: string; email_relacionamento: string | null }>;
  const op = operadores[0];

  if (!op) {
    return errorPage("Operador não encontrado", `Sem operador cadastrado pra user_id=${stateRow.user_id}.`);
  }

  const emailMismatch =
    op.email_relacionamento &&
    gmailEmail.toLowerCase() !== op.email_relacionamento.toLowerCase();

  // 5. Salva credentials
  const expiresAt = new Date(Date.now() + (tokenJson.expires_in ?? 3600) * 1000).toISOString();

  const updateRes = await fetch(`${supabaseUrl}/rest/v1/operadores?id=eq.${op.id}`, {
    method: "PATCH",
    headers: { ...supaHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({
      gmail_oauth_credentials: {
        refresh_token: tokenJson.refresh_token,
        email: gmailEmail,
        scope: tokenJson.scope,
        conectado_em: new Date().toISOString(),
        access_token_expira_em: expiresAt,
        access_token_cache: tokenJson.access_token,
      },
    }),
  });

  if (!updateRes.ok) {
    const errTxt = await updateRes.text();
    return errorPage("Erro ao salvar credenciais", `Status ${updateRes.status}: ${errTxt.slice(0, 200)}`);
  }

  // 6. Limpa state
  await fetch(`${supabaseUrl}/rest/v1/oauth_pending_states?state=eq.${encodeURIComponent(state)}`, {
    method: "DELETE",
    headers: supaHeaders,
  });

  return successPage(op.nome, gmailEmail, emailMismatch ? op.email_relacionamento : null);
}

function successPage(nome: string, gmailEmail: string, emailEsperadoSeMismatch: string | null): Response {
  const aviso = emailEsperadoSeMismatch
    ? `<p style="background:#fff8e1;padding:10px;border-left:3px solid #d4a017;font-size:13px;color:#5d4914;margin-top:16px;">⚠️ Você autorizou com <strong>${escapeHtml(gmailEmail)}</strong>, mas o operador esperado era <strong>${escapeHtml(emailEsperadoSeMismatch)}</strong>. Se isso não for um alias intencional, desconecta e refaça com a conta certa.</p>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gmail conectado — Sal Express</title>
<style>
body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;max-width:520px;margin:80px auto;padding:24px;text-align:center;color:#1a1a1a}
h1{font-size:20px;color:#0a8c3e;margin-bottom:8px}
p{font-size:14px;color:#555;line-height:1.6}
.check{font-size:48px;margin-bottom:8px}
.logo{font-weight:700;color:#c1272d;font-size:12px;letter-spacing:1px;margin-bottom:32px}
</style>
</head>
<body>
<div class="logo">SAL EXPRESS</div>
<div class="check">✅</div>
<h1>Gmail conectado!</h1>
<p>Olá <strong>${escapeHtml(nome)}</strong>, sua conta <strong>${escapeHtml(gmailEmail)}</strong> está conectada ao Cockpit. Os emails automáticos vão sair direto da sua caixa, com a reputação do Gmail (sem spam).</p>
${aviso}
<p style="margin-top:24px;color:#888;font-size:12px;">Pode fechar essa aba e voltar pro Cockpit.</p>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function errorPage(titulo: string, msg: string): Response {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(titulo)} — Sal Express</title>
<style>
body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;max-width:520px;margin:80px auto;padding:24px;text-align:center;color:#1a1a1a}
h1{font-size:20px;color:#c1272d;margin-bottom:8px}
p{font-size:14px;color:#555;line-height:1.6}
.logo{font-weight:700;color:#c1272d;font-size:12px;letter-spacing:1px;margin-bottom:32px}
</style>
</head>
<body>
<div class="logo">SAL EXPRESS</div>
<h1>${escapeHtml(titulo)}</h1>
<p>${escapeHtml(msg)}</p>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
