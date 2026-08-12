import { obterSessao, readSswLancamentoEnv, buscarNFInterno } from "../_shared/ssw-internal-client.ts";
const BASE = "https://sistema.ssw.inf.br"; const UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126 Safari/537.36";
function unesc(s: string){ return s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'"); }
Deno.serve(async (req) => {
  const { nf, ctrc } = await req.json().catch(() => ({})) as { nf?: string; ctrc?: string };
  const out: Record<string, unknown> = {};
  try {
    const s = await obterSessao(readSswLancamentoEnv(Deno.env.toObject()));
    const cookie = [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const det = await buscarNFInterno(s, nf!, ctrc ? { ctrcEsperado: ctrc } : undefined);
    const frm = det.html.match(/<form[^>]*name=["']?frm["']?[\s\S]*?<\/form>/i)?.[0] ?? det.html;
    const campos: Record<string,string> = {};
    for (const m of frm.matchAll(/<input[^>]*>/gi)) { const n = m[0].match(/name=["']?([\w]+)["']?/i)?.[1]; if (n) campos[n] = m[0].match(/value=["']([^"']*)["']/i)?.[1] ?? ""; }
    const body = new URLSearchParams(); body.set("act","A");
    for (const [k,v] of Object.entries(campos)) if (k!=="act" && v!=="") body.append(k,v);
    const h = await (await fetch(`${BASE}/bin/ssw0053`, { method:"POST", headers:{ "User-Agent":UA, cookie, "Content-Type":"application/x-www-form-urlencoded", Referer:`${BASE}/bin/ssw0053` }, body: body.toString() })).text();
    const hu = unesc(unesc(h)); // duplo unescape (aninhado)
    // dump completo desescapado da area da tabela
    const ti = hu.indexOf("2467883");
    out.trecho_apos_nf = hu.slice(ti, ti + 1400);
    // todos os ajaxEnvia agora que desescapou 2x
    out.ajax_calls = [...hu.matchAll(/ajaxEnvia\(([^)]{0,120})\)/gi)].map(m=>m[1]);
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
