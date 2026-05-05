// r.ts — Vercel Edge Function pra rastrear NF no SSW via auto-submit POST.
//
// Por que Vercel e não Supabase: Supabase Edge Functions e Storage forçam
// Content-Type: text/plain + nosniff por design (defesa anti-phishing),
// impossível servir HTML. Vercel respeita o text/html que mandamos.
//
// Fluxo:
//   1. Cliente clica link no email → /api/r?t=<uuid>
//   2. Esta função chama Supabase REST pra:
//      - Validar token em tokens_evidencia (existe + não expirou)
//      - Pegar senha em tracking_credentials pelo cnpj_pagador
//   3. Retorna HTML com form auto-submit pra ssw.inf.br/2/ssw_resultSSW_pag_nro
//   4. Navegador POST → SSW autenticado → cliente vê foto SSWMobile

export const config = { runtime: "edge" };

const SSW_URL = "https://ssw.inf.br/2/ssw_resultSSW_pag_nro";
const VOLTAR_URL = "https://salexpress.com.br";

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  if (!token) return errorPage("Link inválido", "Token ausente.");

  const supabaseUrl = process.env.SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!supabaseUrl || !serviceKey) return errorPage("Configuração", "Servidor incompleto.");

  // 1. Valida token via REST
  const tokenRes = await fetch(
    `${supabaseUrl}/rest/v1/tokens_evidencia?id=eq.${encodeURIComponent(token)}&select=id,cnpj_pagador,nf,expira_em,total_acessos`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  if (!tokenRes.ok) return errorPage("Erro", `Falha ao validar token (${tokenRes.status}).`);
  const tokens = (await tokenRes.json()) as Array<{ id: string; cnpj_pagador: string; nf: string; expira_em: string; total_acessos: number }>;
  const t = tokens[0];
  if (!t) return errorPage("Link inválido ou expirado", "Token não encontrado. Solicite um novo à equipe Sal Express.");
  if (new Date(t.expira_em) < new Date()) return errorPage("Link expirado", "Este link expirou (vale 7 dias). Solicite um novo à equipe Sal Express.");

  // 2. Busca senha
  const credRes = await fetch(
    `${supabaseUrl}/rest/v1/tracking_credentials?documento=eq.${encodeURIComponent(t.cnpj_pagador)}&ativo=eq.true&select=senha`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const creds = (await credRes.json()) as Array<{ senha: string | null }>;
  const senha = creds[0]?.senha;
  if (!senha) {
    return errorPage(
      "Rastreio temporariamente indisponível",
      `Senha do CNPJ ${maskCnpj(t.cnpj_pagador)} não cadastrada. Equipe Sal Express foi notificada.`,
    );
  }

  // 3. Atualiza contador async (fire and forget)
  fetch(`${supabaseUrl}/rest/v1/tokens_evidencia?id=eq.${encodeURIComponent(t.id)}`, {
    method: "PATCH",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ultimo_acesso: new Date().toISOString(), total_acessos: t.total_acessos + 1 }),
  }).catch(() => {});

  // 4. Renderiza HTML auto-submit
  const html = renderAutoSubmit({ cnpjpag: t.cnpj_pagador, nf: t.nf, chave: senha });
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function renderAutoSubmit(p: { cnpjpag: string; nf: string; chave: string }): string {
  const e = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Abrindo rastreio Sal Express…</title>
<style>
body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;max-width:480px;margin:80px auto;padding:24px;text-align:center;color:#1a1a1a}
h1{font-size:18px;font-weight:600;margin-bottom:8px;color:#c1272d}
p{font-size:14px;color:#555;line-height:1.5}
.spinner{display:inline-block;width:32px;height:32px;border:3px solid #f1f1f1;border-top-color:#c1272d;border-radius:50%;animation:spin .8s linear infinite;margin:24px auto}
@keyframes spin{to{transform:rotate(360deg)}}
.btn{display:inline-block;margin-top:12px;padding:10px 20px;background:#c1272d;color:#fff;text-decoration:none;border-radius:6px;border:0;cursor:pointer;font-size:14px}
</style>
</head>
<body>
<h1>Abrindo seu rastreio</h1>
<p>Você está sendo redirecionado para o portal SSW com o status atualizado da sua entrega.</p>
<div class="spinner" aria-hidden="true"></div>
<p style="font-size:12px;color:#999">Se a página não abrir em alguns segundos, clique em "Continuar":</p>
<form id="frm" method="POST" action="${SSW_URL}" target="_self">
<input type="hidden" name="cnpjpag" value="${e(p.cnpjpag)}">
<input type="hidden" name="NR"      value="${e(p.nf)}">
<input type="hidden" name="chave"   value="${e(p.chave)}">
<input type="hidden" name="urlori"  value="${VOLTAR_URL}">
<button type="submit" class="btn">Continuar →</button>
</form>
<script>document.getElementById('frm').submit();</script>
</body>
</html>`;
}

function errorPage(titulo: string, msg: string): Response {
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${titulo} — Sal Express</title>
<style>body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;max-width:480px;margin:80px auto;padding:24px;text-align:center;color:#1a1a1a}h1{font-size:18px;font-weight:600;margin-bottom:8px;color:#c1272d}p{font-size:14px;color:#555;line-height:1.5}.logo{font-weight:700;color:#c1272d;font-size:12px;letter-spacing:1px;margin-bottom:32px}</style>
</head><body><div class="logo">SAL EXPRESS</div><h1>${titulo}</h1><p>${msg}</p></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function maskCnpj(c: string): string {
  if (c.length !== 14) return c;
  return `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5,8)}/${c.slice(8,12)}-${c.slice(12)}`;
}
