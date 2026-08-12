// TEMPORÁRIO — procura "Remessa" no HTML do detalhe e no ajaxEnvia do JS principal.
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
    // 1. Remessa direto no HTML do detalhe?
    const ctx = [...det.html.matchAll(/.{0,40}Remessa.{0,60}/gi)].map((m) => m[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 8);
    out.remessa_no_detalhe = ctx;
    // 2. ajaxEnvia no JS principal
    const js = await (await fetch(`${BASE}/scripts/ssw_300626.js?version=1`, { headers: { "User-Agent": UA, cookie } })).text();
    const fn = js.match(/function\s+ajaxEnvia\b[\s\S]{0,1600}?\n\}/i);
    out.ajaxEnvia = fn ? fn[0] : "não achou no ssw_300626";
    // 3. act=920691 (o que tinha Remessa)
    const r = await fetch(`${BASE}/bin/ssw0053?act=920691&seq_ctrc=${det.seq_ctrc}`, { headers: { "User-Agent": UA, cookie, Referer: `${BASE}/bin/ssw0053` } });
    const h2 = await r.text();
    out.act920691_remessa = [...h2.matchAll(/.{0,30}Remessa.{0,50}/gi)].map((m) => m[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 5);
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
