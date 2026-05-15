// r.ts — Vercel Edge Function: proxy pro endpoint Supabase r-evidencia.
//
// Caio 2026-05-15 (onboarding Duilio):
// CÓDIGO LEGADO (3 hops em /api/trackingpag + tracking_credentials) REMOVIDO.
// O endpoint Supabase `r-evidencia` já faz tudo via SSW INTERNO (opção 101,
// login Sal por operador atribuído ao card) e retorna a foto binária direto.
// O motivo de manter o Vercel é só Content-Type: Supabase força text/plain
// em algumas respostas; pra binary (image/*) ele respeita o Content-Type
// custom, então `redirect 302` pra Supabase funciona.
//
// Bug fix: cliente recebia tela "Senha do CNPJ não cadastrada" quando o
// pagador não tinha registro em `tracking_credentials`. Esta tabela está
// sendo deprecada (Fase 3 do plano "hoje-usamos-o-bastao"). Agora o cliente
// vai direto pro Supabase r-evidencia que cobre 100% das ocs sem precisar
// de senha do cliente.

export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  if (!token) return errorPage("Link inválido", "Token ausente.");

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    return errorPage(
      "Configuração",
      "Servidor incompleto. Equipe Sal Express foi notificada.",
    );
  }

  // 302 → Supabase Edge r-evidencia. Ela valida token, faz scrape via SSW
  // interno (creds do operador atribuído ao card) e retorna image/jpeg
  // inline. Browser segue redirect e mostra foto direto.
  const debug = url.searchParams.get("debug") === "1";
  const target = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/r-evidencia?t=${encodeURIComponent(token)}${debug ? "&debug=1" : ""}`;

  return Response.redirect(target, 302);
}

function errorPage(titulo: string, msg: string): Response {
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${titulo} — Sal Express</title>
<style>body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;max-width:480px;margin:80px auto;padding:24px;text-align:center;color:#1a1a1a}h1{font-size:18px;font-weight:600;margin-bottom:8px;color:#c1272d}p{font-size:14px;color:#555;line-height:1.5}.logo{font-weight:700;color:#c1272d;font-size:12px;letter-spacing:1px;margin-bottom:32px}</style>
</head><body><div class="logo">SAL EXPRESS</div><h1>${titulo}</h1><p>${msg}</p></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
