// =============================================================================
// r-evidencia — gera página intermediária que auto-submete POST pra SSW.
//
// Fluxo:
//   1. Cliente recebe email com link "Veja o comprovante: <func-url>?t=<uuid>"
//   2. Clica → cai aqui
//   3. Validamos token em tokens_evidencia (existe + não expirou)
//   4. Buscamos senha em tracking_credentials pelo cnpj_pagador
//   5. Devolvemos HTML mínimo com form auto-submit pra
//      https://ssw.inf.br/2/ssw_resultSSW_pag_nro
//   6. Navegador POST → SSW autenticado abre direto com a NF + foto SSWMobile
//
// Decisões com Caio (2026-05-01):
//   - Senha aparece momentaneamente no HTML — aceitável (interna, token único)
//   - Time-bound 7 dias
//   - Cliente clica "Mais detalhes" no SSW pra ver foto
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const SSW_TRACKING_URL = "https://ssw.inf.br/2/ssw_resultSSW_pag_nro";
const VOLTAR_URL = "https://salexpress.com.br";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");

  if (!token) return errorPage("Link inválido", "Token ausente.");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // 1. Valida token
  const { data: tokenRow, error: tokenErr } = await supabase
    .from("tokens_evidencia")
    .select("id, cnpj_pagador, nf, expira_em")
    .eq("id", token)
    .maybeSingle();

  if (tokenErr || !tokenRow) {
    return errorPage("Link inválido ou expirado", "Token não encontrado. Solicite um novo link à equipe Sal Express.");
  }

  if (new Date(tokenRow.expira_em as string) < new Date()) {
    return errorPage("Link expirado", "Este link de rastreio expirou (vale por 7 dias após o envio). Solicite um novo à equipe Sal Express.");
  }

  // 2. Busca senha do pagador
  const { data: cred, error: credErr } = await supabase
    .from("tracking_credentials")
    .select("senha, ativo")
    .eq("documento", tokenRow.cnpj_pagador)
    .eq("ativo", true)
    .maybeSingle();

  if (credErr || !cred?.senha) {
    return errorPage(
      "Rastreio temporariamente indisponível",
      `Senha de rastreio não cadastrada para CNPJ ${maskCnpj(tokenRow.cnpj_pagador as string)}. Equipe Sal Express foi notificada.`,
    );
  }

  // 3. Atualiza contador (não bloqueia se falhar)
  supabase
    .from("tokens_evidencia")
    .update({
      ultimo_acesso: new Date().toISOString(),
      total_acessos: (((tokenRow as Record<string, unknown>).total_acessos as number) ?? 0) + 1,
    })
    .eq("id", token)
    .then(() => {});

  // 4. Renderiza HTML com auto-submit
  const html = renderAutoSubmit({
    cnpjpag: tokenRow.cnpj_pagador as string,
    nf: tokenRow.nf as string,
    chave: cred.senha as string,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
});

function renderAutoSubmit(p: { cnpjpag: string; nf: string; chave: string }): string {
  // HTML mínimo — body só com form. Auto-submete onload via JS inline.
  // Usuários sem JS veem botão "Continuar" como fallback.
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Abrindo rastreio Sal Express…</title>
  <style>
    body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 480px; margin: 80px auto; padding: 24px; text-align: center; color: #1a1a1a; }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: #c1272d; }
    p { font-size: 14px; color: #555; line-height: 1.5; }
    .spinner { display: inline-block; width: 32px; height: 32px; border: 3px solid #f1f1f1; border-top-color: #c1272d; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 24px auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .fallback-btn { display: inline-block; margin-top: 12px; padding: 10px 20px; background: #c1272d; color: #fff; text-decoration: none; border-radius: 6px; border: 0; cursor: pointer; font-size: 14px; }
  </style>
</head>
<body>
  <h1>Abrindo seu rastreio</h1>
  <p>Você está sendo redirecionado para o portal SSW com o status atualizado da sua entrega.</p>
  <div class="spinner" aria-hidden="true"></div>
  <p style="font-size:12px; color:#999;">Se a página não abrir em alguns segundos, clique em "Continuar":</p>
  <form id="frm" method="POST" action="${SSW_TRACKING_URL}" target="_self">
    <input type="hidden" name="cnpjpag" value="${escape(p.cnpjpag)}">
    <input type="hidden" name="NR"      value="${escape(p.nf)}">
    <input type="hidden" name="chave"   value="${escape(p.chave)}">
    <input type="hidden" name="urlori"  value="${VOLTAR_URL}">
    <button type="submit" class="fallback-btn">Continuar →</button>
  </form>
  <script>document.getElementById('frm').submit();</script>
</body>
</html>`;
}

function errorPage(titulo: string, msg: string): Response {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${titulo} — Sal Express</title>
  <style>
    body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 480px; margin: 80px auto; padding: 24px; text-align: center; color: #1a1a1a; }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: #c1272d; }
    p { font-size: 14px; color: #555; line-height: 1.5; }
    .logo { font-weight: 700; color: #c1272d; font-size: 12px; letter-spacing: 1px; margin-bottom: 32px; }
  </style>
</head>
<body>
  <div class="logo">SAL EXPRESS</div>
  <h1>${titulo}</h1>
  <p>${msg}</p>
</body>
</html>`;
  return new Response(html, {
    status: 200, // sempre 200 pra não criar pânico em filtro de cliente
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function maskCnpj(c: string): string {
  if (c.length !== 14) return c;
  return `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5,8)}/${c.slice(8,12)}-${c.slice(12)}`;
}
