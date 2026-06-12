// r.ts — Vercel Edge Function: serve evidência da NF (galeria HTML ou redirect imagem).
//
// Caio 2026-06-11 (NF 357224 LARISSA): Supabase Edge Runtime sobrescreve
// Content-Type=text/html → text/plain + CSP sandbox + nosniff. Resultado:
// browser do cliente NÃO renderiza HTML — mostra texto cru com mojibake
// ("EvidÃªncia â€" NF 357224") e nenhuma imagem aparece. Pra contornar,
// o HTML da galeria PRECISA sair daqui (Vercel respeita Content-Type).
//
// Estratégia:
//   - 1 chamada `?meta=1` pro Supabase Edge → JSON `{fotos_total, oc_descricao, nf}`.
//   - Se 0 fotos ou erro: errorPage Vercel (HTML servido daqui mesmo).
//   - Se 1 foto: 302 redirect pro Supabase Edge (binary, content-type respeitado).
//   - Se >1 fotos: monta HTML galeria AQUI com `<img>` apontando pra URLs
//     absolutas no Supabase Edge.
//
// Caio 2026-05-15 (legado): código antigo (3 hops + tracking_credentials)
// removido na Fase 3. Endpoint Supabase r-evidencia já faz tudo via SSW
// interno e retorna foto binária respeitando Content-Type=image/jpeg.

export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  const debug = url.searchParams.get("debug") === "1";
  const idxParam = url.searchParams.get("idx");

  if (!token) return errorPage("Link inválido", "Token ausente.");

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    return errorPage(
      "Configuração",
      "Servidor incompleto. Equipe Sal Express foi notificada.",
    );
  }
  const baseEdge = supabaseUrl.replace(/\/+$/, "");

  // Se cliente já trouxe `?idx=N`, é uma <img> da galeria — redirect direto
  // pra binary do Supabase (sem chamar meta).
  if (idxParam != null) {
    const target = `${baseEdge}/functions/v1/r-evidencia?t=${encodeURIComponent(token)}&idx=${encodeURIComponent(idxParam)}`;
    return Response.redirect(target, 302);
  }

  // Modo debug do Vercel: passa debug pro Supabase, redirect.
  if (debug) {
    const target = `${baseEdge}/functions/v1/r-evidencia?t=${encodeURIComponent(token)}&debug=1`;
    return Response.redirect(target, 302);
  }

  // 1. Pega metadata
  let meta: {
    ok?: boolean;
    nf?: string;
    fotos_total?: number;
    oc_descricao?: string;
    status?: string;
    descricao?: string;
    motivo?: string;
  };
  try {
    const metaRes = await fetch(
      `${baseEdge}/functions/v1/r-evidencia?t=${encodeURIComponent(token)}&meta=1`,
      { cache: "no-store" },
    );
    if (!metaRes.ok) {
      return errorPage(
        "Evidência indisponível",
        "Não foi possível carregar as informações da entrega. Tente novamente em alguns minutos.",
      );
    }
    meta = await metaRes.json();
  } catch {
    return errorPage(
      "Erro temporário",
      "Não foi possível carregar a evidência agora. Tente novamente em alguns minutos.",
    );
  }

  if (!meta.ok) {
    const msg = meta.descricao ?? meta.motivo ?? "Esta evidência não está disponível.";
    return errorPage("Evidência indisponível", msg);
  }

  const total = typeof meta.fotos_total === "number" ? meta.fotos_total : 1;
  const nf = meta.nf ?? "";

  // 2. Caso 1 foto: redirect 302 pra binary direto (Supabase respeita image/jpeg).
  if (total <= 1) {
    const target = `${baseEdge}/functions/v1/r-evidencia?t=${encodeURIComponent(token)}&idx=0`;
    return Response.redirect(target, 302);
  }

  // 3. Caso galeria: serve HTML AQUI com `<img>` apontando pra Supabase.
  const imgUrl = (n: number) =>
    `${baseEdge}/functions/v1/r-evidencia?t=${encodeURIComponent(token)}&idx=${n}`;
  const figures = Array.from({ length: total })
    .map(
      (_, n) =>
        `<figure><img src="${escapeAttr(imgUrl(n))}" alt="Evidência ${n + 1} de ${total}" loading="lazy"><figcaption>Foto ${n + 1} de ${total}</figcaption></figure>`,
    )
    .join("\n");

  const ocDescricao = escapeHtml(meta.oc_descricao ?? "");
  const nfEsc = escapeHtml(nf);

  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidência — NF ${nfEsc}</title>
<meta name="robots" content="noindex,nofollow">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 16px; color: #1a1a1a; background: #f5f1ea; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
  p.meta { color: #666; font-size: 13px; margin-top: 0; margin-bottom: 24px; }
  figure { margin: 0 0 32px; }
  img { width: 100%; height: auto; border: 1px solid #ddd; border-radius: 6px; background: #fff; }
  figcaption { font-size: 13px; color: #666; margin-top: 6px; text-align: center; }
</style></head>
<body>
  <h1>Evidência registrada — NF ${nfEsc}</h1>
  <p class="meta">${ocDescricao} · ${total} fotos disponíveis</p>
  ${figures}
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, max-age=300",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

function errorPage(titulo: string, msg: string): Response {
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(titulo)} — Sal Express</title>
<style>body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;max-width:480px;margin:80px auto;padding:24px;text-align:center;color:#1a1a1a}h1{font-size:18px;font-weight:600;margin-bottom:8px;color:#c1272d}p{font-size:14px;color:#555;line-height:1.5}.logo{font-weight:700;color:#c1272d;font-size:12px;letter-spacing:1px;margin-bottom:32px}</style>
</head><body><div class="logo">SAL EXPRESS</div><h1>${escapeHtml(titulo)}</h1><p>${escapeHtml(msg)}</p></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
