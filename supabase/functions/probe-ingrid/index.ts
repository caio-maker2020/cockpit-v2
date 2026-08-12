import { obterSessao, readSswLancamentoEnv } from "../_shared/ssw-internal-client.ts";
const BASE = "https://sistema.ssw.inf.br"; const UA = "Mozilla/5.0";
Deno.serve(async () => {
  const out: Record<string, unknown> = {};
  try {
    const s = await obterSessao(readSswLancamentoEnv(Deno.env.toObject()));
    const cookie = [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const js = await (await fetch(`${BASE}/scripts/ssw_300626.js?version=1`, { headers: { "User-Agent": UA, cookie } })).text();
    const i = js.indexOf("function ajaxEnvia");
    out.corpo = js.slice(i, i + 3800);
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
