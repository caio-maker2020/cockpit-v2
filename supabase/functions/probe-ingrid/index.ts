// TEMPORÁRIO — investiga o act=XML: resposta CRUA (headers/ct/corpo), GET e POST.
import { obterSessao, readSswLancamentoEnv, buscarNFInterno } from "../_shared/ssw-internal-client.ts";
const BASE = "https://sistema.ssw.inf.br"; const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36";
Deno.serve(async (req) => {
  const { nf, ctrc } = await req.json().catch(() => ({})) as { nf?: string; ctrc?: string };
  const out: Record<string, unknown> = {};
  try {
    const s = await obterSessao(readSswLancamentoEnv(Deno.env.toObject()));
    const det = await buscarNFInterno(s, nf!, ctrc ? { ctrcEsperado: ctrc } : undefined);
    const cookie = [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const frm = det.html.match(/<form[^>]*name=["']?frm["']?[\s\S]*?<\/form>/i)?.[0] ?? det.html;
    const campos: Record<string,string> = {};
    for (const m of frm.matchAll(/<input[^>]*>/gi)) {
      const name = m[0].match(/name=["']?([\w]+)["']?/i)?.[1]; if (!name) continue;
      campos[name] = m[0].match(/value=["']([^"']*)["']/i)?.[1] ?? "";
    }
    out.campos_form = Object.keys(campos);
    const qs = new URLSearchParams(); qs.set("act", "XML");
    for (const [k,v] of Object.entries(campos)) { if (k!=="act" && v!=="") qs.append(k, v); }
    qs.set("dummy", String(Date.now()));
    const rg = await fetch(`${BASE}/bin/ssw0053?${qs.toString()}`, { headers: { "User-Agent": UA, cookie, Referer: `${BASE}/bin/ssw0053`, "X-Requested-With": "XMLHttpRequest" } });
    const bg = await rg.text();
    out.GET = { status: rg.status, ct: rg.headers.get("content-type"), cd: rg.headers.get("content-disposition"), bytes: bg.length, corpo: bg.slice(0, 900) };
    const rp = await fetch(`${BASE}/bin/ssw0053`, { method:"POST", headers: { "User-Agent": UA, cookie, "Content-Type":"application/x-www-form-urlencoded", Referer: `${BASE}/bin/ssw0053`, "X-Requested-With": "XMLHttpRequest" }, body: qs.toString() });
    const bp = await rp.text();
    out.POST = { status: rp.status, ct: rp.headers.get("content-type"), bytes: bp.length, corpo: bp.slice(0, 900) };
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
