// =============================================================================
// alterar-especie-cliente — troca a espécie de um cliente no SSW (opção 382)
//
// Limitação sistêmica do SSW: 1 cliente por vez. Esta função faz o ciclo
// completo via HTTP (login → lookup CNPJ → gravar → re-verificar) através do
// adapter `alterarEspecieCliente` em _shared/ssw-internal-client.ts.
//
// `codigos` é o conjunto EXATO que deve ficar marcado ao final. Pra cumprir a
// regra "só uma espécie marcada", mandar um único código (ex.: ["022"]).
//
// Auth: JWT verificado (NÃO é --no-verify-jwt) — só quem tem token Supabase
// válido chama. Sem proxy aberto.
//
// Input  POST JSON: { "cnpj": "13820950664", "codigos": ["022"], "operador"?: "LARISSA" }
// Output JSON: AlterarEspecieResult (ok, antes[], depois[], cliente, ...)
// =============================================================================

import {
  readSswInternalEnv,
  alterarEspecieCliente,
} from "../_shared/ssw-internal-client.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return j({ ok: false, erro: "POST only" }, 405);
  const env = Deno.env.toObject();

  let body: { cnpj?: string; codigos?: string[]; operador?: string };
  try {
    body = await req.json();
  } catch {
    return j({ ok: false, erro: "bad json" }, 400);
  }

  const cnpj = (body.cnpj ?? "").replace(/\D/g, "");
  const codigos = Array.isArray(body.codigos) ? body.codigos.map(String) : [];
  if (!cnpj) return j({ ok: false, erro: "cnpj obrigatório" }, 400);
  if (codigos.length === 0) return j({ ok: false, erro: "codigos obrigatório (ex: [\"022\"])" }, 400);

  try {
    const sswEnv = readSswInternalEnv(env, body.operador ?? null);
    const resultado = await alterarEspecieCliente(sswEnv, cnpj, codigos);
    return j(resultado, resultado.ok ? 200 : 422);
  } catch (err) {
    return j(
      { ok: false, cnpj, erro: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

function j(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
