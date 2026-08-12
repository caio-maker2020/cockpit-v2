// TEMPORÁRIO — dump da tela DANFES (act=A) pra achar o elemento do XML.
import { obterSessao, readSswLancamentoEnv, buscarNFInterno } from "../_shared/ssw-internal-client.ts";
const BASE = "https://sistema.ssw.inf.br"; const UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126 Safari/537.36";
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
    body.set("dummy", String(Date.now()));
    const r = await fetch(`${BASE}/bin/ssw0053`, { method:"POST", headers:{ "User-Agent":UA, cookie, "Content-Type":"application/x-www-form-urlencoded", Referer:`${BASE}/bin/ssw0053` }, body: body.toString() });
    const h = await r.text();
    out.bytes = h.length;
    // qualquer elemento (a/td/img/input) que mencione XML
    out.elementos_xml = [...h.matchAll(/<(a|td|img|input|span|div)\b[^>]*(?:xml|XML)[^>]*>/gi)].map(m=>m[0].slice(0,200)).slice(0,10);
    // onclicks que apareçam
    out.onclicks = [...h.matchAll(/onclick\s*=\s*["']([^"']+)["']/gi)].map(m=>m[1]).filter(o=>/xml|ssw|ajaxEnvia|abre/i.test(o)).slice(0,12);
    // linha da tabela de NF
    out.linha_nf = h.match(/.{0,80}2467883.{0,300}/)?.[0]?.replace(/<[^>]+>/g,' | ').replace(/\s+/g,' ') ?? "nf não achada na tabela";
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
