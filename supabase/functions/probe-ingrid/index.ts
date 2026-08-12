// TEMPORÁRIO — caça a def de ajaxEnvia e o handler de XML nos JS.
import { obterSessao, readSswLancamentoEnv } from "../_shared/ssw-internal-client.ts";
const BASE = "https://sistema.ssw.inf.br";
const UA = "Mozilla/5.0";
Deno.serve(async () => {
  const env = Deno.env.toObject();
  const out: Record<string, unknown> = {};
  try {
    const s = await obterSessao(readSswLancamentoEnv(env));
    const cookie = [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    for (const src of ["/scripts/ssw_300626.js?version=1", "/scripts/ssw0053_270726.js?version=1"]) {
      const js = await (await fetch(`${BASE}${src}`, { headers: { "User-Agent": UA, cookie } })).text();
      const nome = src.split("/").pop()!.split("?")[0];
      // def de ajaxEnvia
      const fn = js.match(/(?:function\s+ajaxEnvia|ajaxEnvia\s*[:=]\s*function)\b[\s\S]{0,1800}?\n\s*\}/i);
      out[`${nome}_ajaxEnvia`] = fn ? fn[0].slice(0, 1600) : "não achou";
      // linhas com XML
      out[`${nome}_linhas_xml`] = js.split("\n").filter((l) => /xml/i.test(l) && !/xmlhttp/i.test(l)).slice(0, 10);
    }
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
