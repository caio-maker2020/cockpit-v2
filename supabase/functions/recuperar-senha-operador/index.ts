// =============================================================================
// recuperar-senha-operador — "Esqueci minha senha" (PÚBLICA, verify_jwt=false).
//
// Operador clica no link na tela de login e informa o e-mail. A função:
//   1. Acha o operador por e-mail (operadores.email, case-insensitive) que tenha
//      login (user_id).
//   2. Aplica cooldown (1 reset por e-mail a cada COOLDOWN_MIN) pra evitar abuso.
//   3. Gera senha nova forte e troca via Auth Admin API (service_role).
//   4. Envia a nova senha por e-mail (Postmark) pro e-mail cadastrado — que é
//      justamente o que o operador usa pra acessar o Cockpit.
//
// SEMPRE responde genérico (não revela se o e-mail existe). Senha em claro só
// trafega no corpo do e-mail; nunca é gravada em log/DB.
//
// NOTA DE SEGURANÇA: enviar senha em claro por e-mail é menos seguro que um link
// de redefinição. Foi pedido explicitamente (ferramenta interna, ~12 operadores).
// O operador deve trocar a senha depois pelo painel/admin se quiser.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const COOLDOWN_MIN = 5;
const FROM_EMAIL = "relacionamento.farmaceutico@salexpress.com.br"; // signature verificada no Postmark
const COCKPIT_URL = "https://cockpit.salexpress.com.br"; // ajuste se a URL do app mudar
const RESP_GENERICA = "Se o e-mail estiver cadastrado, você receberá uma nova senha em instantes.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Senha forte sem caracteres ambíguos (O/0/I/l/1).
function gerarSenha(len = 12): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#%";
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  let s = "";
  for (const n of arr) s += chars[n % chars.length];
  return s;
}

async function enviarEmailSenha(token: string, para: string, nome: string, senha: string): Promise<boolean> {
  const subject = "Cockpit Sal Express — sua nova senha de acesso";
  const textBody =
    `Olá, ${nome}.\n\n` +
    `Você (ou alguém) solicitou a recuperação de senha do Cockpit.\n\n` +
    `Sua nova senha de acesso é:\n\n    ${senha}\n\n` +
    `Acesse: ${COCKPIT_URL}\nLogin: ${para}\n\n` +
    `Por segurança, recomendamos trocar essa senha após entrar.\n` +
    `Se não foi você, avise o Caio.\n\n— Cockpit Sal Express`;
  const htmlBody =
    `<p>Olá, <b>${nome}</b>.</p>` +
    `<p>Você (ou alguém) solicitou a recuperação de senha do Cockpit.</p>` +
    `<p>Sua nova senha de acesso é:</p>` +
    `<p style="font-size:20px;font-weight:bold;letter-spacing:1px;background:#f4f4f5;padding:12px 16px;border-radius:8px;display:inline-block">${senha}</p>` +
    `<p>Acesse: <a href="${COCKPIT_URL}">${COCKPIT_URL}</a><br>Login: ${para}</p>` +
    `<p>Por segurança, recomendamos trocar essa senha após entrar. Se não foi você, avise o Caio.</p>` +
    `<p>— Cockpit Sal Express</p>`;

  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify({
      From: `Cockpit Sal Express <${FROM_EMAIL}>`,
      To: para,
      Subject: subject,
      TextBody: textBody,
      HtmlBody: htmlBody,
      MessageStream: "outbound",
      Tag: "cockpit-reset-senha",
    }),
  });
  return res.ok;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  try {
    const env = Deno.env.toObject();
    const svc = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const postmarkToken = env["POSTMARK_SERVER_TOKEN"];

    const body = await req.json().catch(() => ({}));
    const email = (body?.email as string | undefined)?.trim().toLowerCase();
    if (!email) return json({ ok: false, error: "Informe o e-mail." }, 400);

    // Busca operador com login. Sempre devolvemos a msg genérica adiante.
    const { data: op } = await svc
      .from("operadores")
      .select("id, nome, email, user_id")
      .ilike("email", email)
      .not("user_id", "is", null)
      .limit(1)
      .maybeSingle();

    // E-mail não cadastrado / sem login → resposta genérica (sem vazar nada).
    if (!op || !op.user_id) {
      return json({ ok: true, message: RESP_GENERICA });
    }

    // Cooldown: já houve reset_senha_self recente?
    const desde = new Date(Date.now() - COOLDOWN_MIN * 60_000).toISOString();
    const { data: recente } = await svc
      .from("operador_credencial_eventos")
      .select("id")
      .eq("operador_id", op.id)
      .eq("tipo", "reset_senha_self")
      .gte("created_at", desde)
      .limit(1)
      .maybeSingle();
    if (recente) {
      // Já enviamos há pouco — não reenvia, mas responde genérico igual.
      return json({ ok: true, message: RESP_GENERICA });
    }

    if (!postmarkToken) {
      console.error("POSTMARK_SERVER_TOKEN ausente — não dá pra enviar reset.");
      return json({ ok: true, message: RESP_GENERICA });
    }

    // Gera + aplica a nova senha.
    const novaSenha = gerarSenha(12);
    const { error: pwErr } = await svc.auth.admin.updateUserById(op.user_id, { password: novaSenha });
    if (pwErr) {
      console.error(`updateUserById falhou: ${pwErr.message}`);
      return json({ ok: true, message: RESP_GENERICA });
    }

    // Envia por e-mail. Só audita se o envio deu certo (senão a senha trocou e o
    // operador ficaria sem saber — mas a troca já ocorreu; logamos a tentativa).
    const enviou = await enviarEmailSenha(postmarkToken, op.email, op.nome ?? "operador(a)", novaSenha);

    await svc.from("operador_credencial_eventos").insert({
      operador_id: op.id,
      tipo: "reset_senha_self",
      ator_email: "self-service",
      detalhe: { email_destino: op.email, email_enviado: enviou },
    });

    return json({ ok: true, message: RESP_GENERICA });
  } catch (e) {
    console.error(`recuperar-senha-operador erro: ${(e as Error).message}`);
    // Mesmo em erro, resposta genérica (não vaza estado).
    return json({ ok: true, message: RESP_GENERICA });
  }
});
