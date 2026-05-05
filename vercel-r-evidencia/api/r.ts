// r.ts — Vercel Edge Function pra rastrear NF no SSW e levar cliente direto
// pra foto da evidência.
//
// Por que Vercel e não Supabase: Supabase Edge Functions e Storage forçam
// Content-Type: text/plain + nosniff por design (defesa anti-phishing),
// impossível servir HTML. Vercel respeita o text/html que mandamos.
//
// Fluxo (regra Caio 2026-05-05 — 1 clique só do cliente):
//   1. Cliente clica link no email → /api/r?t=<uuid>
//   2. Esta função:
//      a) Valida token em tokens_evidencia
//      b) Pega senha em tracking_credentials pelo cnpj_pagador
//      c) Hop 1: POST autenticado em ssw_resultSSW_pag_nro (capta cookies)
//      d) Hop 2: GET ssw_SSWDetalhado, parsa HTML pra achar URL da foto
//      e) Hop 3: redirect 302 direto pra URL da foto
//   3. Cliente vê foto direto. Sem cliques extras no SSW.
//
// Fallback defensivo: se SSW mudar HTML e regex falhar, cai no auto-submit
// antigo (cliente vê tela intermediária + clica "Mais detalhes" — 1 clique
// extra mas funcionando).

export const config = { runtime: "edge" };

const SSW_AUTH_URL = "https://ssw.inf.br/2/ssw_resultSSW_pag_nro";
const SSW_DETALHE_URL = "https://ssw.inf.br/2/ssw_SSWDetalhado";
const SSW_BASE = "https://ssw.inf.br";
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

  // 4. Tenta scraping server-side pra ir direto na foto
  try {
    const fotoUrl = await resolveFotoUrl({ cnpjpag: t.cnpj_pagador, nf: t.nf, senha });
    if (fotoUrl) {
      return Response.redirect(fotoUrl, 302);
    }
  } catch (err) {
    console.warn(`[r-evidencia] scraping falhou, fallback auto-submit: ${err}`);
  }

  // 5. Fallback: auto-submit pra cliente clicar manualmente "Mais detalhes"
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

// ============================================================================
// resolveFotoUrl — 3 hops com cookie jar mantida manualmente
// ============================================================================

interface SswScrapeInput {
  cnpjpag: string;
  nf: string;
  senha: string;
}

async function resolveFotoUrl(input: SswScrapeInput): Promise<string | null> {
  const jar = new Map<string, string>();

  function applySetCookie(headers: Headers) {
    // Edge runtime não tem getSetCookie() universal; lê do header bruto.
    // `getSetCookie()` existe em Node 20+; quando indisponível, parse manual.
    const list: string[] = (headers as { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
    for (const raw of list) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (k && v) jar.set(k, v);
    }
  }

  function cookieHeader(): string {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  // Hop 1: POST autentica e abre a sessão SSW pra essa NF
  const auth = await fetch(SSW_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; SalExpressEvidencia/1.0)",
      cookie: cookieHeader(),
    },
    body: new URLSearchParams({
      cnpjpag: input.cnpjpag,
      NR: input.nf,
      chave: input.senha,
      urlori: VOLTAR_URL,
    }),
    redirect: "manual",
  });
  applySetCookie(auth.headers);
  if (auth.status >= 500) {
    throw new Error(`SSW auth retornou ${auth.status}`);
  }

  // Hop 1.5: HTML do hop1 já contém link "Mais detalhes" com params id/md.
  // SSW NÃO usa cookies — autenticação é via params no body POST.
  // Pra hop2 funcionar, precisa propagar id/md (não basta GET no detalhe).
  const auth1Text = await auth.text();
  const detalheParam = auth1Text.match(/ssw_SSWDetalhado\?id=([^"'&\s]+)&md=([^"'&\s]+)/);
  if (!detalheParam) return null;
  const idParam = detalheParam[1]!;
  const mdParam = detalheParam[2]!;

  // Hop 2: GET detalhe com id/md
  const detalhe = await fetch(
    `${SSW_DETALHE_URL}?id=${encodeURIComponent(idParam)}&md=${encodeURIComponent(mdParam)}`,
    {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SalExpressEvidencia/1.0)",
        cookie: cookieHeader(),
        Referer: SSW_AUTH_URL,
      },
      redirect: "follow",
    },
  );
  applySetCookie(detalhe.headers);
  const html = await detalhe.text();
  if (!html) return null;

  // Foto NÃO está como link <a href="/2/picture?..."> direto. Vem como
  // botão com atributos HTML: <a id="btn_foto" pid="X" ft="Y" emp="Z">
  // que o JS do SSW transforma em URL /2/picture?key=X&key2=Y&e=Z ao clicar.
  // Pega o ÚLTIMO btn_foto da página (mais recente — foto da última oc).
  const fotoMatches = [...html.matchAll(
    /<a[^>]*id=["']btn_foto["'][^>]*pid=["']([^"']+)["'][^>]*ft=["']([^"']+)["'][^>]*emp=["']([^"']+)["']/gi,
  )];
  if (fotoMatches.length > 0) {
    const last = fotoMatches[fotoMatches.length - 1]!;
    const pid = last[1]!;
    const ft = last[2]!;
    const emp = last[3]!;
    return `${SSW_BASE}/2/picture?key=${encodeURIComponent(pid)}&key2=${encodeURIComponent(ft)}&e=${encodeURIComponent(emp)}`;
  }

  // Fallback: tentar atributos em ordem alternativa
  const altPid = html.match(/id=["']btn_foto["'][^>]*pid=["']([^"']+)["']/i);
  const altFt = html.match(/id=["']btn_foto["'][^>]*ft=["']([^"']+)["']/i);
  const altEmp = html.match(/id=["']btn_foto["'][^>]*emp=["']([^"']+)["']/i);
  if (altPid && altFt && altEmp) {
    return `${SSW_BASE}/2/picture?key=${encodeURIComponent(altPid[1]!)}&key2=${encodeURIComponent(altFt[1]!)}&e=${encodeURIComponent(altEmp[1]!)}`;
  }

  return null;
}

// ============================================================================
// HTML helpers (fallback quando scraping falha)
// ============================================================================

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
.aviso{font-size:12px;color:#777;margin-top:16px}
</style>
</head>
<body>
<h1>Abrindo seu rastreio</h1>
<p>Você está sendo redirecionado para o portal SSW com o status atualizado da sua entrega.</p>
<div class="spinner" aria-hidden="true"></div>
<p class="aviso">Se ver a tela do SSW, clique em "Mais detalhes" → "Foto" pra ver a evidência da entrega.</p>
<form id="frm" method="POST" action="${SSW_AUTH_URL}" target="_self">
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
