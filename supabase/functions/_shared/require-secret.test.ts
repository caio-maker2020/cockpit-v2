// Guard: require-secret middleware (SEG-2). Fail-closed sempre.
// Rodar: deno test --allow-env supabase/functions/_shared/require-secret.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { requireSecret } from "./require-secret.ts";

const ENV_VAR = "TEST_COCKPIT_SECRET";

function reqWithHeader(headerName: string | null, value: string | null): Request {
  const headers = new Headers();
  if (headerName && value !== null) headers.set(headerName, value);
  return new Request("https://example.com/fn", { headers });
}

Deno.test("nega fail-closed quando a env var não está configurada", () => {
  Deno.env.delete(ENV_VAR);
  const result = requireSecret(reqWithHeader("x-cockpit-secret", "qualquer-coisa"), { envVar: ENV_VAR });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.motivo, "env_nao_configurada");
});

Deno.test("nega quando o header do segredo está ausente", () => {
  Deno.env.set(ENV_VAR, "segredo-correto");
  const result = requireSecret(reqWithHeader(null, null), { envVar: ENV_VAR });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.motivo, "segredo_ausente");
  Deno.env.delete(ENV_VAR);
});

Deno.test("nega quando o segredo enviado não bate com o configurado", () => {
  Deno.env.set(ENV_VAR, "segredo-correto");
  const result = requireSecret(reqWithHeader("x-cockpit-secret", "segredo-errado"), { envVar: ENV_VAR });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.motivo, "segredo_invalido");
  Deno.env.delete(ENV_VAR);
});

Deno.test("nega quando o segredo enviado tem tamanho diferente do configurado", () => {
  Deno.env.set(ENV_VAR, "segredo-correto-mais-longo");
  const result = requireSecret(reqWithHeader("x-cockpit-secret", "curto"), { envVar: ENV_VAR });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.motivo, "segredo_invalido");
  Deno.env.delete(ENV_VAR);
});

Deno.test("aceita quando o segredo enviado bate exatamente", () => {
  Deno.env.set(ENV_VAR, "segredo-correto");
  const result = requireSecret(reqWithHeader("x-cockpit-secret", "segredo-correto"), { envVar: ENV_VAR });
  assertEquals(result.ok, true);
  Deno.env.delete(ENV_VAR);
});

Deno.test("respeita headerName customizado", () => {
  Deno.env.set(ENV_VAR, "segredo-correto");
  const result = requireSecret(reqWithHeader("x-internal-cron-secret", "segredo-correto"), {
    envVar: ENV_VAR,
    headerName: "x-internal-cron-secret",
  });
  assertEquals(result.ok, true);
  Deno.env.delete(ENV_VAR);
});
