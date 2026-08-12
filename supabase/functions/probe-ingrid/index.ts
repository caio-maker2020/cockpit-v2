// TEMPORÁRIO — desescapa a linha DANFES e acha o link XML; segue e extrai remessa.
import { obterSessao, readSswLancamentoEnv, buscarNFInterno } from "../_shared/ssw-internal-client.ts";
import { extrairNumeroRemessa, extrairNumeroRemessaDoXmlNfe } from "../_shared/danfe-remessa.ts";
const BASE = "https://sistema.ssw.inf.br"; const UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126 Safari/537.36";
function unesc(s: string){ return s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/&quot;/g,'"'); }
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
    const hu = unesc(h);
    // todos os ajaxEnvia da tela DANFES desescapada
    out.ajax_calls = [...hu.matchAll(/ajaxEnvia\(([^)]*)\)/gi)].map(m=>m[1]).slice(0,15);
    // acha o que tem XML
    const xmlCall = [...hu.matchAll(/ajaxEnvia\('?(\w*)'?\s*,\s*\d+\s*,\s*'([^']*(?:xml|XML)[^']*)'/gi)].map(m=>m[2]);
    out.xml_targets = xmlCall;
    // procura link/onclick com act=XML ou ssw que gere xml
    out.linhas_xml = [...hu.matchAll(/[^\n]*XML[^\n]*/gi)].map(l=>l.replace(/\s+/g,' ').trim().slice(0,220)).slice(0,6);
    // segue o primeiro target de xml se achou
    if (xmlCall.length) {
      const alvo = xmlCall[0].replace(/&/g,"&");
      const url = `${BASE}/bin/${alvo}${alvo.includes("?")?"&":"?"}dummy=${Date.now()}`;
      const rx = await fetch(url, { headers:{ "User-Agent":UA, cookie, Referer:`${BASE}/bin/ssw0053` } });
      const bx = await rx.text();
      out.xml_result = { url, status: rx.status, ct: rx.headers.get("content-type"), bytes: bx.length, remessa: extrairNumeroRemessaDoXmlNfe(bx) ?? extrairNumeroRemessa(bx), ini: bx.slice(0,300).replace(/\s+/g,' ') };
    }
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
