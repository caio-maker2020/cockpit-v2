// TEMPORÁRIO — descompacta o ZIP do XML NF-e e extrai a Remessa.
import { obterSessao, readSswLancamentoEnv, buscarNFInterno } from "../_shared/ssw-internal-client.ts";
import { extrairNumeroRemessa, extrairDadosAdicionaisDoXmlNfe } from "../_shared/danfe-remessa.ts";
import { unzip } from "https://deno.land/x/zipjs@v2.7.45/index.js";
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
    const b = new URLSearchParams(); b.set("act","A");
    for (const [k,v] of Object.entries(campos)) if (k!=="act" && v!=="") b.append(k,v);
    const h = unesc(unesc(await (await fetch(`${BASE}/bin/ssw0053`, { method:"POST", headers:{ "User-Agent":UA, cookie, "Content-Type":"application/x-www-form-urlencoded", Referer:`${BASE}/bin/ssw0053` }, body: b.toString() })).text()));
    const xmlHref = h.match(/(https?:\/\/[^'"\s]*ssw1188[^'"\s]*)/i)?.[1];
    if (!xmlHref) { out.erro = "sem link XML"; return new Response(JSON.stringify(out), { headers: {"Content-Type":"application/json"} }); }
    const zipBytes = new Uint8Array(await (await fetch(xmlHref, { headers:{ "User-Agent":UA, cookie } })).arrayBuffer());
    // descompacta via DecompressionStream (raw deflate do zip entry)
    // método robusto: usa a lib zipjs
    const entries = await unzip(zipBytes);
    const nomes = Object.keys(entries);
    out.zip_entries = nomes;
    const xmlEntry = nomes.find(n => /nfe\.xml$/i.test(n)) ?? nomes[0];
    const xmlText = new TextDecoder("utf-8").decode(entries[xmlEntry]);
    out.xml_bytes = xmlText.length;
    out.dados_adicionais = extrairDadosAdicionaisDoXmlNfe(xmlText)?.slice(0,300) ?? "(sem infCpl)";
    out.remessa = extrairNumeroRemessa(extrairDadosAdicionaisDoXmlNfe(xmlText));
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
