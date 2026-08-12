// TEMPORÁRIO — lê o corpo de ajaxEnvia no JS e testa o XML com o form completo.
import { obterSessao, readSswLancamentoEnv, buscarNFInterno } from "../_shared/ssw-internal-client.ts";
const BASE = "https://sistema.ssw.inf.br";
const UA = "Mozilla/5.0";
Deno.serve(async (req) => {
  const { nf, ctrc } = await req.json().catch(() => ({})) as { nf?: string; ctrc?: string };
  const env = Deno.env.toObject();
  const out: Record<string, unknown> = {};
  try {
    const s = await obterSessao(readSswLancamentoEnv(env));
    const det = await buscarNFInterno(s, nf!, ctrc ? { ctrcEsperado: ctrc } : undefined);
    const cookie = [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    // baixa o JS e extrai ajaxEnvia
    const js = await (await fetch(`${BASE}/scripts/ssw0053_270726.js?version=1`, { headers: { "User-Agent": UA, cookie } })).text();
    const fn = js.match(/function\s+ajaxEnvia\s*\([^)]*\)\s*\{[\s\S]{0,1500}?\n\}/i);
    out.ajaxEnvia = fn ? fn[0] : "não achou";
    // monta o form COMPLETO do detalhe (todos inputs) e envia com act=XML
    const inputs: Record<string, string> = {};
    for (const m of det.html.matchAll(/<input[^>]*name=["']?([\w]+)["']?[^>]*?(?:value=["']([^"']*)["'])?[^>]*>/gi)) {
      inputs[m[1]] = m[2] ?? "";
    }
    inputs["act"] = "XML";
    const r = await fetch(`${BASE}/bin/ssw0053`, {
      method: "POST", headers: { "User-Agent": UA, cookie, "Content-Type": "application/x-www-form-urlencoded", Referer: `${BASE}/bin/ssw0053` },
      body: new URLSearchParams(inputs).toString(),
    });
    const body = await r.text();
    out.xml_form_completo = { status: r.status, bytes: body.length, temXml: /<\?xml|infCpl|nfeProc/i.test(body), temRemessa: /Remessa/i.test(body), ini: body.slice(0, 300).replace(/\s+/g, " ") };
    out.inputs_enviados = Object.keys(inputs).slice(0, 40);
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
