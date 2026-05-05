// =============================================================================
// oauth-gmail-start
//
// Operadora autenticada chama essa função pra iniciar OAuth com Gmail.
// 1. Identifica user_id via auth.uid() (Bearer token)
// 2. Mapeia user_id → operadores.id
// 3. Gera state UUID, salva em oauth_pending_states (TTL 10min)
// 4. Retorna URL de autorização do Google
//
// Frontend faz window.location = response.auth_url e o navegador da operadora
// é redirecionado pra accounts.google.com pra autorizar.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  // gmail.compose habilita criar drafts/responder threads (não usado hoje, mas plano)
  "https://www.googleapis.com/auth/gmail.compose",
  // openid + userinfo.email permitem chamar /oauth2/v2/userinfo pra
  // identificar qual conta autorizou (sem isso userinfo retorna vazio).
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const env = Deno.env.toObject();
    const clientId = env["GOOGLE_OAUTH_CLIENT_ID"];
    if (!clientId) {
      return json({ ok: false, error: "GOOGLE_OAUTH_CLIENT_ID ausente" }, 500);
    }

    // 1. Auth do usuário (Bearer token)
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ ok: false, error: "Authorization Bearer obrigatório" }, 401);
    }

    const supabaseUser = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_ANON_KEY"]!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userRes } = await supabaseUser.auth.getUser();
    const user = userRes?.user;
    if (!user) {
      return json({ ok: false, error: "User não autenticado" }, 401);
    }

    // 2. Mapeia user_id → operadores.id (mesmo user pode ter múltiplos? pegar primeiro ativo)
    const supabaseSvc = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { data: op } = await supabaseSvc
      .from("operadores")
      .select("id, nome, email_relacionamento")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    if (!op) {
      return json({ ok: false, error: `Operador não cadastrado pra user_id=${user.id}` }, 403);
    }

    // 3. Gera state, salva em oauth_pending_states
    const { data: stateRow, error: stateErr } = await supabaseSvc
      .from("oauth_pending_states")
      .insert({ user_id: user.id })
      .select("state")
      .single();

    if (stateErr || !stateRow) {
      return json({ ok: false, error: `criar state: ${stateErr?.message}` }, 500);
    }

    // 4. Constroi URL de autorização do Google
    // redirect_uri DEVE bater EXATAMENTE com a configurada no OAuth Client.
    // Hospedado no Vercel (Supabase força text/plain — não serve HTML do callback).
    const redirectUri = "https://cockpit-r-evidencia.vercel.app/api/oauth-gmail-callback";

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", SCOPES);
    authUrl.searchParams.set("access_type", "offline");      // pra receber refresh_token
    authUrl.searchParams.set("prompt", "consent");           // força tela mesmo se já autorizado (garante refresh_token)
    authUrl.searchParams.set("state", stateRow.state as string);
    // Login_hint ajuda a operadora a logar com o email certo
    if (op.email_relacionamento) {
      authUrl.searchParams.set("login_hint", op.email_relacionamento);
    }

    return json({
      ok: true,
      auth_url: authUrl.toString(),
      operador_id: op.id,
      operador_nome: op.nome,
      email_esperado: op.email_relacionamento,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("oauth-gmail-start fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
