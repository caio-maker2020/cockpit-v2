// TEMPORÁRIO — unzip NATIVO (DecompressionStream) da entry nfe.xml.
import { obterSessao, readSswLancamentoEnv, buscarNFInterno } from "../_shared/ssw-internal-client.ts";
import { extrairNumeroRemessa, extrairDadosAdicionaisDoXmlNfe } from "../_shared/danfe-remessa.ts";
const BASE = "https://sistema.ssw.inf.br"; const UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126 Safari/537.36";
function unesc(s: string){ return s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'"); }
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const w = ds.writable.getWriter(); w.write(bytes); w.close();
  const chunks: Uint8Array[] = []; const r = ds.readable.getReader();
  for(;;){ const { done, value } = await r.read(); if (done) break; chunks.push(value); }
  const total = chunks.reduce((a,c)=>a+c.length,0); const outb = new Uint8Array(total); let o=0;
  for (const c of chunks){ outb.set(c,o); o+=c.length; } return outb;
}
function primeiraEntryDeflate(zip: Uint8Array): { nome: string; dados: Uint8Array } | null {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let p = 0;
  while (p + 30 <= zip.length && dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p+8, true);
    let csize = dv.getUint32(p+18, true);
    const fnlen = dv.getUint16(p+26, true); const exlen = dv.getUint16(p+28, true);
    const nome = new TextDecoder().decode(zip.slice(p+30, p+30+fnlen));
    const dataStart = p+30+fnlen+exlen;
    if (csize === 0) { // data descriptor: procura o próximo PK
      let e = dataStart; while (e+4 < zip.length && dv.getUint32(e,true)!==0x08074b50 && dv.getUint32(e,true)!==0x02014b50) e++;
      csize = e - dataStart;
    }
    const dados = zip.slice(dataStart, dataStart+csize);
    if (/\.xml$/i.test(nome)) return { nome, dados: method===8 ? dados : dados };
    p = dataStart + csize;
  }
  return null;
}
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
    const zip = new Uint8Array(await (await fetch(xmlHref!, { headers:{ "User-Agent":UA, cookie } })).arrayBuffer());
    const entry = primeiraEntryDeflate(zip);
    out.entry_nome = entry?.nome ?? "não achou entry xml";
    if (entry) {
      const xmlText = new TextDecoder("utf-8").decode(await inflateRaw(entry.dados));
      out.xml_bytes = xmlText.length;
      out.dados_adicionais = extrairDadosAdicionaisDoXmlNfe(xmlText)?.slice(0,400) ?? "(sem infCpl)";
      out.remessa = extrairNumeroRemessa(extrairDadosAdicionaisDoXmlNfe(xmlText));
    }
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
