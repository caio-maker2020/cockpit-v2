// Testes do guard "modo visualização" (mig 324). Fake do admin client cobre
// os 4 caminhos: service_role livre, operador travado, operador livre, sem sub.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { bloquearSeModoVisualizacao, claimsDoBearer } from "./trava-visualizacao.ts";

function reqComClaims(claims: Record<string, unknown>): Request {
  const payload = btoa(JSON.stringify(claims));
  return new Request("http://x", { headers: { Authorization: `Bearer h.${payload}.s` } });
}

function adminFake(pode: boolean | null): Parameters<typeof bloquearSeModoVisualizacao>[1] {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: pode === null ? null : { pode_executar: pode } }),
        }),
      }),
    }),
  };
}

Deno.test("service_role nunca trava (cron/edge-to-edge)", async () => {
  const r = await bloquearSeModoVisualizacao(reqComClaims({ role: "service_role" }), adminFake(false));
  assertEquals(r, null);
});

Deno.test("operador pode_executar=false → 403 MODO_VISUALIZACAO", async () => {
  const r = await bloquearSeModoVisualizacao(reqComClaims({ sub: "uid-joao" }), adminFake(false));
  assertEquals(r?.status, 403);
  const body = await r!.json();
  assertEquals(body.ok, false);
  assertEquals(String(body.error).startsWith("MODO_VISUALIZACAO"), true);
});

Deno.test("operador pode_executar=true → livre (zero regressão operadores)", async () => {
  const r = await bloquearSeModoVisualizacao(reqComClaims({ sub: "uid-maria" }), adminFake(true));
  assertEquals(r, null);
});

Deno.test("sem operador na tabela → livre (fail-open)", async () => {
  const r = await bloquearSeModoVisualizacao(reqComClaims({ sub: "uid-x" }), adminFake(null));
  assertEquals(r, null);
});

Deno.test("sem Authorization → livre (função decide a própria auth)", async () => {
  const r = await bloquearSeModoVisualizacao(new Request("http://x"), adminFake(false));
  assertEquals(r, null);
});

Deno.test("claimsDoBearer tolera token malformado", () => {
  const req = new Request("http://x", { headers: { Authorization: "Bearer lixo" } });
  assertEquals(claimsDoBearer(req), {});
});
