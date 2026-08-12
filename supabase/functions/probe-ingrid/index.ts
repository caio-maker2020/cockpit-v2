// TEMPORÁRIO — replica ajaxEnvia('XML',0): GET ssw0053?act=XML&<campos do form frm>
import { obterSessao, readSswLancamentoEnv, buscarNFInterno } from "../_shared/ssw-internal-client.ts";
import { extrairNumeroRemessaDoXmlNfe } from "../_shared/danfe-remessa.ts";
const BASE = "https://sistema.ssw.inf.br"; const UA = "Mozilla/5.0";
Deno.serve(async (req) => {
  const { nf, ctrc } = await req.json().catch(() => ({})) as { nf?: string; ctrc?: string };
  const out: Record<string, unknown> = {};
  try {
    const s = await obterSessao(readSswLancamentoEnv(Deno.env.toObject()));
    const det = await buscarNFInterno(s, nf!, ctrc ? { ctrcEsperado: ctrc } : undefined);
    const cookie = [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    // pega SÓ o form name=frm
    const frm = det.html.match(/<form[^>]*name=["']?frm["']?[\s\S]*?<\/form>/i)?.[0] ?? det.html;
    const params = new URLSearchParams();
    params.set("act", "XML");
    for (const m of frm.matchAll(/<input[^>]*>/gi)) {
      const tag = m[0];
      const name = tag.match(/name=["']?([\w]+)["']?/i)?.[1];
      if (!name || name === "act") continue;
      const type = (tag.match(/type=["']?(\w+)["']?/i)?.[1] ?? "text").toUpperCase();
      const value = tag.match(/value=["']([^"']*)["']/i)?.[1] ?? "";
      if ((type === "TEXT" || type === "HIDDEN" || type === "PASSWORD") && value !== "") params.append(name, value);
    }
    params.set("dummy", String(Date.now()));
    const url = `${BASE}/bin/ssw0053?${params.toString()}`;
    const r = await fetch(url, { headers: { "User-Agent": UA, cookie, Referer: `${BASE}/bin/ssw0053` } });
    const body = await r.text();
    out.status = r.status; out.bytes = body.length;
    out.temXml = /<\?xml|nfeProc|infNFe/i.test(body);
    out.temInfCpl = /infCpl/i.test(body);
    out.remessa = extrairNumeroRemessaDoXmlNfe(body);
    out.ini = body.slice(0, 200).replace(/\s+/g, " ");
    // se é um wrapper que aponta pro xml, mostra links
    if (!out.temXml) out.links = [...body.matchAll(/(?:href|src)=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 10);
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
