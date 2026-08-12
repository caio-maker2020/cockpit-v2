// TEMPORÁRIO — dump do HTML das telas 101>DANFEs pra achar o link XML real.
import { obterSessao, readSswLancamentoEnv, buscarNFInterno } from "../_shared/ssw-internal-client.ts";
import { extrairAlvosDeLink } from "../_shared/danfe-remessa.ts";

const BASE = "https://sistema.ssw.inf.br";
const UA = "Mozilla/5.0";

Deno.serve(async (req) => {
  const { nf, ctrc } = await req.json().catch(() => ({})) as { nf?: string; ctrc?: string };
  const env = Deno.env.toObject();
  const out: Record<string, unknown> = {};
  try {
    const s = await obterSessao(readSswLancamentoEnv(env));
    const det = await buscarNFInterno(s, nf!, ctrc ? { ctrcEsperado: ctrc } : undefined);
    out.detalhe_bytes = det.html.length;
    out.links_danfe = extrairAlvosDeLink(det.html, "DANFE");
    // todos os <a> com href/onclick pra ver o formato
    out.todos_links_detalhe = (det.html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [])
      .filter((a) => /danfe|xml|impr/i.test(a)).slice(0, 15);
    // se achou DANFEs, busca a tela e dumpa
    const cookie = [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    if ((out.links_danfe as string[]).length) {
      const alvo = (out.links_danfe as string[])[0];
      const url = /^https?:/.test(alvo) ? alvo : `${BASE}${alvo.startsWith("/") ? "" : "/bin/"}${alvo}`;
      const r = await fetch(url, { headers: { "User-Agent": UA, cookie, Referer: `${BASE}/bin/ssw0053` } });
      const html = await r.text();
      out.danfes_url = url;
      out.danfes_bytes = html.length;
      out.danfes_links_xml = extrairAlvosDeLink(html, "XML");
      out.danfes_links_todos = (html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []).slice(0, 20);
      out.danfes_amostra = html.slice(0, 1500);
    }
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
