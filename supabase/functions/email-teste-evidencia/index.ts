// email-teste-evidencia — função AD-HOC pra mandar email teste com link de
// evidência REAL (token + r-evidencia + auto-submit SSW). Pode ser deletada
// após o teste.
//
// POST body (todos opcionais):
//   {
//     to?: string;          // default: caio@salexpress.com.br
//     nf?: string;          // default: 27668 (PRATI)
//     via?: "postmark" | "gmail_larissa";  // default: postmark
//   }
//
// Esse endpoint NÃO toca no card real (não muda state, não cria propostas,
// não lança oc, não manda email pra cliente). Único side-effect: 1 INSERT em
// tokens_evidencia (consultado pelo Vercel /r?t=<id> quando o link é clicado).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sendGmailMessage } from "../_shared/gmail-sender.ts";

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const body = await req.json().catch(() => ({}));
  const to: string = body.to ?? "caio@salexpress.com.br";
  const nf: string = String(body.nf ?? "27668");
  const via: "postmark" | "gmail_larissa" = body.via === "gmail_larissa" ? "gmail_larissa" : "postmark";

  // 1. Busca card pela NF + extrai cnpj_pagador
  const { data: card } = await supabase
    .from("cards")
    .select("id, nf, empresa_cliente, agent_state")
    .eq("nf", nf)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!card) {
    return new Response(JSON.stringify({ ok: false, error: `card NF ${nf} não encontrado` }), { status: 404 });
  }
  const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
  const cnpjPagador = (agentState["cnpj_pagador"] as string | undefined)
    ?? (nf === "27668" ? "16366888000110" : null);
  if (!cnpjPagador) {
    return new Response(JSON.stringify({ ok: false, error: `card NF ${nf} sem cnpj_pagador no agent_state` }), { status: 400 });
  }
  const empresaCliente = (card.empresa_cliente as string | null) ?? "Cliente";

  // 2. Cria token de 7 dias (linha nova em tokens_evidencia)
  const expiraEm = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: tokenRow, error: tokErr } = await supabase
    .from("tokens_evidencia")
    .insert({
      card_id: card.id,
      cnpj_pagador: cnpjPagador,
      nf,
      expira_em: expiraEm,
    })
    .select("id")
    .single();
  if (tokErr || !tokenRow) {
    return new Response(JSON.stringify({ ok: false, error: `criar token: ${tokErr?.message}` }), { status: 500 });
  }

  // Vercel hospeda a página que faz scraping server-side dos 3 hops SSW e
  // redireciona direto pra foto. Mesma base URL que o executor usa
  // (env EVIDENCIA_BASE_URL com fallback) — mantém canal único pra cliente.
  const baseEvidencia = Deno.env.get("EVIDENCIA_BASE_URL") ?? "https://cockpit-r-evidencia.vercel.app";
  const linkEvidencia = `${baseEvidencia}/r?t=${tokenRow.id}`;

  // 3. Compõe email
  const subject = `[Sal Express — TESTE] NF ${nf} — evidência da entrega`;
  const textBody = [
    "Olá Caio,",
    "",
    `Email de TESTE simulando o que cliente "${empresaCliente}" recebe na NF ${nf}.`,
    "",
    `Link de evidência (1 clique → foto direto): ${linkEvidencia}`,
    "",
    "—",
    "Larissa",
    "Sal Express — Relacionamento",
    "",
    "—",
    `(Este é um teste — clica no link e veja se cai direto na foto da entrega no SSW. Token válido até ${new Date(expiraEm).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.)`,
  ].join("\n");

  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; color: #1a1a1a; line-height: 1.6; padding: 20px;">
  <div style="background:#fff8f6; border-left: 3px solid #c1272d; padding: 10px 14px; margin-bottom: 24px; font-size:13px; color:#666;">
    <strong>EMAIL DE TESTE</strong> — simulação do que ${empresaCliente} receberia na NF ${nf}. Clica no botão pra ver o novo fluxo (1 clique → foto direto).
  </div>
  <p>Olá Caio,</p>
  <p>Segue o link de evidência da entrega da <strong>NF ${nf}</strong> nos novos moldes (com scraping server-side):</p>
  <p style="margin: 24px 0; text-align:center;">
    <a href="${linkEvidencia}" style="display:inline-block; padding:14px 28px; background:#c1272d; color:#fff; text-decoration:none; border-radius:6px; font-weight:600; font-size:15px;">📍 Veja a evidência da entrega</a>
  </p>
  <p style="margin-top: 32px;">Larissa<br><span style="color:#888; font-size:13px;">Sal Express — Relacionamento</span></p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
  <p style="color: #888; font-size: 12px;">
    <strong>Como deve funcionar agora:</strong> ao clicar no botão, você verá uma tela curta de loading (1-2s) enquanto o backend Vercel autentica no SSW e parsa o HTML pra achar a URL exata da foto. Em seguida, redirect direto pra <code>ssw.inf.br/2/picture?key=...</code> — sem precisar clicar em "Mais detalhes" nem em "Foto" no painel.
  </p>
  <p style="color: #888; font-size: 12px;">
    Se o SSW mudar o HTML e o parser falhar, você cai no fluxo antigo (tela intermediária + clicar "Mais detalhes") — fallback defensivo.<br>
    Token válido até: ${new Date(expiraEm).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}<br>
    URL: <code>${linkEvidencia}</code>
  </p>
</body>
</html>`;

  // 4. Envia via canal escolhido
  if (via === "gmail_larissa") {
    // Carrega Larissa (mesmo padrão do email-teste-gmail-oauth)
    const { data: operador } = await supabase
      .from("operadores")
      .select("id, nome, gmail_oauth_credentials")
      .eq("nome", "LARISSA")
      .maybeSingle();
    if (!operador?.id) {
      return new Response(JSON.stringify({ ok: false, error: "Operadora LARISSA não encontrada" }), { status: 404 });
    }
    if (!(operador as Record<string, unknown>).gmail_oauth_credentials) {
      return new Response(JSON.stringify({ ok: false, error: "Larissa sem gmail_oauth_credentials" }), { status: 400 });
    }

    // Helper só envia text/plain hoje. Pra simular email real do cliente,
    // usamos o textBody (cliente vê texto plano + link). Se quiser HTML
    // futuramente, estender helper.
    const result = await sendGmailMessage({
      supabase,
      operadorId: operador.id as string,
      destinatario: to,
      cc: null,
      subject,
      texto: textBody,
      fromName: "Sal Express — Relacionamento",
    });

    return new Response(JSON.stringify({
      ok: result.ok,
      via: "gmail_larissa",
      operador: "LARISSA",
      to,
      nf,
      token_id: tokenRow.id,
      link: linkEvidencia,
      expira_em: expiraEm,
      result,
    }, null, 2), {
      status: result.ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Default: Postmark (fluxo antigo, mantido)
  const postmarkToken = Deno.env.get("POSTMARK_SERVER_TOKEN");
  if (!postmarkToken) {
    return new Response(JSON.stringify({ ok: false, error: "POSTMARK_SERVER_TOKEN ausente" }), { status: 500 });
  }
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": postmarkToken,
    },
    body: JSON.stringify({
      From: "Cockpit Sal Express <relacionamento.farmaceutico@salexpress.com.br>",
      To: to,
      Subject: subject,
      TextBody: textBody,
      HtmlBody: htmlBody,
      MessageStream: "outbound",
      Tag: "cockpit-teste-link-evidencia-real",
      Metadata: { card_id: card.id as string, nf, token_evidencia: tokenRow.id },
    }),
  });
  const respText = await res.text();
  return new Response(JSON.stringify({
    ok: res.ok,
    via: "postmark",
    status: res.status,
    postmark: respText.slice(0, 300),
    to,
    nf,
    token_id: tokenRow.id,
    link: linkEvidencia,
    expira_em: expiraEm,
  }, null, 2), {
    status: res.ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
});
