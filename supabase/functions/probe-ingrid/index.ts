// TEMPORÁRIO — resto do ajaxEnvia (newPage) + segue ajaxEnvia('A',1) tela DANFES.
import { obterSessao, readSswLancamentoEnv, buscarNFInterno } from "../_shared/ssw-internal-client.ts";
const BASE = "https://sistema.ssw.inf.br"; const UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126 Safari/537.36";
Deno.serve(async (req) => {
  const { nf, ctrc } = await req.json().catch(() => ({})) as { nf?: string; ctrc?: string };
  const out: Record<string, unknown> = {};
  try {
    const s = await obterSessao(readSswLancamentoEnv(Deno.env.toObject()));
    const cookie = [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    // resto do ajaxEnvia (parte newPage/submit)
    const js = await (await fetch(`${BASE}/scripts/ssw_300626.js?version=1`, { headers: { "User-Agent": UA, cookie } })).text();
    const i = js.indexOf("function ajaxEnvia");
    out.ajaxEnvia_resto = js.slice(i + 3400, i + 5200);
    // detalhe + segue A,1 (DANFES). newp=1 → o JS deve abrir com method distinto.
    const det = await buscarNFInterno(s, nf!, ctrc ? { ctrcEsperado: ctrc } : undefined);
    const frm = det.html.match(/<form[^>]*name=["']?frm["']?[\s\S]*?<\/form>/i)?.[0] ?? det.html;
    const campos: Record<string,string> = {};
    for (const m of frm.matchAll(/<input[^>]*>/gi)) { const n = m[0].match(/name=["']?([\w]+)["']?/i)?.[1]; if (n) campos[n] = m[0].match(/value=["']([^"']*)["']/i)?.[1] ?? ""; }
    out.chave_nfe = campos["g_ctrc_c_chave_fis"] ?? "(vazio)";
    // tenta act=A (DANFES)
    const qs = new URLSearchParams(); qs.set("act", "A");
    for (const [k,v] of Object.entries(campos)) if (k!=="act" && v!=="") qs.append(k, v);
    const rA = await fetch(`${BASE}/bin/ssw0053?${qs.toString()}&dummy=${Date.now()}`, { headers: { "User-Agent": UA, cookie, Referer: `${BASE}/bin/ssw0053` } });
    const bA = await rA.text();
    out.actA = { status: rA.status, bytes: bA.length, temDanfe: /DANFE/i.test(bA), temXmlLink: /XML/i.test(bA), links: [...bA.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter(m=>/xml|danfe|impr/i.test(m[0])).map(m=>m[0].slice(0,140)).slice(0,8), ini: bA.slice(0,200).replace(/\s+/g,' ') };
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
