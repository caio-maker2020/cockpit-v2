// TEMPORÁRIO — acha a definição de ajaxEnvia + os hiddens (seq_ctrc etc).
import { obterSessao, readSswLancamentoEnv, buscarNFInterno } from "../_shared/ssw-internal-client.ts";
Deno.serve(async (req) => {
  const { nf, ctrc } = await req.json().catch(() => ({})) as { nf?: string; ctrc?: string };
  const env = Deno.env.toObject();
  const out: Record<string, unknown> = {};
  try {
    const s = await obterSessao(readSswLancamentoEnv(env));
    const det = await buscarNFInterno(s, nf!, ctrc ? { ctrcEsperado: ctrc } : undefined);
    const h = det.html;
    // corpo da função ajaxEnvia
    const fn = h.match(/function\s+ajaxEnvia\s*\([^)]*\)\s*\{[\s\S]*?\n\}/i);
    out.ajaxEnvia = fn ? fn[0].slice(0, 1200) : "não achou a função no HTML do detalhe";
    // qualquer url/endpoint que apareça perto
    out.urls_no_js = [...new Set((h.match(/ssw\d{3,4}|\/bin\/[a-z0-9]+|act=\w+|url\s*[:=]\s*['"][^'"]+/gi) ?? []))].slice(0, 30);
    // hiddens
    out.hiddens = (h.match(/<input[^>]*type=["']?hidden["']?[^>]*>/gi) ?? []).map((i) => i.slice(0, 120)).slice(0, 20);
    // seq_ctrc / familia
    out.seq_ctrc = det.seq_ctrc; out.familia = det.familia;
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
