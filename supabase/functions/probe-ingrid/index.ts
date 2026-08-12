// TEMPORÁRIO — testa endpoints candidatos do XML da NF-e.
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
    const seq = det.seq_ctrc, fam = det.familia;
    const cookie = [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    // acha o script src do JS de detalhe
    out.scripts = (det.html.match(/<script[^>]*src=["']([^"']+)["']/gi) ?? []).slice(0, 8);
    const cand: Array<[string, string, RequestInit]> = [
      ["ssw0053 act=XML POST", `${BASE}/bin/ssw0053`, { method: "POST", body: new URLSearchParams({ act: "XML", seq_ctrc: seq, FAMILIA: fam }).toString() }],
      ["ssw0767 GET", `${BASE}/bin/ssw0767?seq_ctrc=${seq}&FAMILIA=${fam}`, {}],
      ["ssw0053 act=XML GET", `${BASE}/bin/ssw0053?act=XML&seq_ctrc=${seq}&FAMILIA=${fam}`, {}],
      ["ssw0053 act=920691 GET", `${BASE}/bin/ssw0053?act=920691&seq_ctrc=${seq}`, {}],
    ];
    const res: Record<string, unknown> = {};
    for (const [nome, url, init] of cand) {
      try {
        const r = await fetch(url, { ...init, headers: { "User-Agent": UA, cookie, Referer: `${BASE}/bin/ssw0053`, ...(init.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) } });
        const body = await r.text();
        res[nome] = { status: r.status, bytes: body.length, temXml: /<\?xml|<nfeProc|<NFe|infCpl/i.test(body), temRemessa: /Remessa/i.test(body), ini: body.slice(0, 120).replace(/\s+/g, " ") };
      } catch (e) { res[nome] = { erro: e instanceof Error ? e.message : String(e) }; }
    }
    out.candidatos = res;
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
