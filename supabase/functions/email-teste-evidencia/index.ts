// email-teste-evidencia — função AD-HOC pra mandar email teste
// com o link de evidência REAL (token + r-evidencia + auto-submit SSW).
// Pode ser deletada após o teste.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

Deno.serve(async (req) => {
  const token = Deno.env.get("POSTMARK_SERVER_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  if (!token) return new Response(JSON.stringify({ ok: false, error: "POSTMARK_SERVER_TOKEN ausente" }), { status: 500 });

  const body = await req.json().catch(() => ({}));
  const to = body.to ?? "caio@salexpress.com.br";

  const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Busca card NF 27668 + cria token de 7 dias
  const { data: card } = await supabase
    .from("cards")
    .select("id, nf, empresa_cliente")
    .eq("nf", "27668")
    .single();
  if (!card) return new Response(JSON.stringify({ ok: false, error: "card NF 27668 não encontrado" }), { status: 404 });

  const expiraEm = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: tokenRow, error: tokErr } = await supabase
    .from("tokens_evidencia")
    .insert({
      card_id: card.id,
      cnpj_pagador: "16366888000110",
      nf: "27668",
      expira_em: expiraEm,
    })
    .select("id")
    .single();
  if (tokErr || !tokenRow) {
    return new Response(JSON.stringify({ ok: false, error: `criar token: ${tokErr?.message}` }), { status: 500 });
  }

  // Vercel hospeda a página HTML auto-submit (Supabase força text/plain).
  const linkEvidencia = `https://cockpit-r-evidencia.vercel.app/r?t=${tokenRow.id}`;

  // 2. Renderiza email simulando template PROBLEMAS_COM_ENDERECO (texto stub)
  const subject = "[Sal Express — TESTE] NF 27668 — confirmar endereço de entrega";

  const textBody = [
    "Olá Caio,",
    "",
    "A entrega da NF 27668 não foi possível por problemas com o endereço.",
    "",
    `Veja a evidência registrada pelo motorista: ${linkEvidencia}`,
    "",
    "Pode confirmar o endereço correto pra reentrega?",
    "",
    "Aguardo retorno.",
    "",
    "Larissa",
    "Sal Express — Relacionamento",
    "",
    "—",
    "Este é um email de TESTE. Clique no link acima — você deve ser redirecionado pro portal SSW autenticado, com a NF 27668 carregada. Em 'Mais detalhes' você verá a foto do SSWMobile.",
  ].join("\n");

  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; color: #1a1a1a; line-height: 1.6; padding: 20px;">

  <div style="background:#fff8f6; border-left: 3px solid #c1272d; padding: 10px 14px; margin-bottom: 24px; font-size:13px; color:#666;">
    <strong>EMAIL DE TESTE</strong> — fluxo real do link de evidência. Clica no link abaixo.
  </div>

  <p>Olá Caio,</p>
  <p>A entrega da <strong>NF 27668</strong> não foi possível por problemas com o endereço.</p>
  <p style="margin: 24px 0;">
    <a href="${linkEvidencia}" style="display:inline-block; padding:12px 22px; background:#c1272d; color:#fff; text-decoration:none; border-radius:6px; font-weight:600;">📍 Veja a evidência da entrega</a>
  </p>
  <p>Pode confirmar o endereço correto pra reentrega?</p>
  <p>Aguardo retorno.</p>
  <p style="margin-top: 32px;">Larissa<br><span style="color:#888; font-size:13px;">Sal Express — Relacionamento</span></p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
  <p style="color: #888; font-size: 12px;">
    <strong>Como deve funcionar:</strong> ao clicar no botão acima, você verá uma página intermediária ("Abrindo seu rastreio") por 1-2s, depois o navegador faz POST automático pro SSW e abre a página de rastreamento autenticada com a NF 27668. Clica em <em>"Mais detalhes"</em> dentro do SSW pra ver a foto do SSWMobile (oc=11 PROBLEMAS COM ENDERECO).
  </p>
  <p style="color: #888; font-size: 12px;">
    Token válido até: ${new Date(expiraEm).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}<br>
    URL completa: ${linkEvidencia}
  </p>
</body>
</html>`;

  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify({
      From: "Cockpit Sal Express <relacionamento.farmaceutico@salexpress.com.br>",
      To: to,
      Subject: subject,
      TextBody: textBody,
      HtmlBody: htmlBody,
      MessageStream: "outbound",
      Tag: "cockpit-teste-link-evidencia-real",
      Metadata: { card_id: card.id, nf: "27668", token_evidencia: tokenRow.id },
    }),
  });

  const respText = await res.text();
  return new Response(JSON.stringify({
    ok: res.ok,
    status: res.status,
    postmark: respText.slice(0, 300),
    to,
    nf: "27668",
    token_id: tokenRow.id,
    link: linkEvidencia,
    expira_em: expiraEm,
  }, null, 2), {
    status: res.ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
});
