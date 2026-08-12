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
    // TODOS os forms e seus actions
    out.forms = [...det.html.matchAll(/<form[^>]*>/gi)].map((m) => m[0]).slice(0, 6);
    // o act=XML pode precisar do form ssw1017 (upload) OU ssw0053. Testa act=XML
    // com GET simples só com seq_ctrc + FAMILIA + a chave (g_ctrc_c_chave_fis)
    const chave = det.html.match(/name=g_ctrc_c_chave_fis[^>]*value="(\d{20,})"/i)?.[1] ?? det.html.match(/(\d{44})/)?.[1] ?? "";
    out.chave_nfe = chave;
    // baixa XML direto da SEFAZ via chave? não. tenta ssw com act e chave
    for (const [nome, url] of [
      ["ssw0053?act=XML&seq", `${BASE}/bin/ssw0053?act=XML&seq_ctrc=${det.seq_ctrc}&FAMILIA=${det.familia}&g_ctrc_nro_ctrc=0&dummy=${Date.now()}`],
      ["ssw0183 chave", `${BASE}/bin/ssw0183?chave=${chave}`],
    ] as const) {
      try {
        const r = await fetch(url, { headers: { "User-Agent": UA, cookie, Referer: `${BASE}/bin/ssw0053` }, redirect: "manual" });
        const b = await r.text();
        (out as Record<string, unknown>)[nome] = { status: r.status, loc: r.headers.get("location"), bytes: b.length, remessa: extrairNumeroRemessaDoXmlNfe(b), temInfCpl: /infCpl/i.test(b), ini: b.slice(0, 120).replace(/\s+/g, " ") };
      } catch (e) { (out as Record<string, unknown>)[nome] = { erro: String(e) }; }
    }
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
