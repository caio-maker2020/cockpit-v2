// =============================================================================
// require-secret — middleware compartilhado de autenticação por segredo
// (Onda 00 · SEG-2), pra funções internas que hoje aceitam chamada anônima.
//
// Uso (no topo do handler, antes de qualquer efeito colateral):
//
//   const auth = requireSecret(req, { envVar: "COCKPIT_EXECUTOR_SECRET" });
//   if (!auth.ok) return jsonResponse(401, { error: auth.detalhe });
//
// Fail-closed sempre: se a env var configurada em `envVar` não estiver
// definida no ambiente da function, a chamada é negada — não existe modo
// "aberto" por falta de configuração. Cada função que adotar este middleware
// (SEG-3, item a item) precisa ter seu segredo definido no Vault/env antes do
// deploy, senão passa a rejeitar 100% das chamadas.
//
// Comparação em tempo constante pra não vazar o segredo via timing attack.
// =============================================================================

export type SecretCheck =
  | { ok: true }
  | {
      ok: false;
      motivo: "env_nao_configurada" | "segredo_ausente" | "segredo_invalido";
      detalhe: string;
    };

export interface RequireSecretOptions {
  /** Nome da env var (Vault) que guarda o segredo esperado, ex: "COCKPIT_EXECUTOR_SECRET". */
  envVar: string;
  /** Header onde o chamador envia o segredo. Default: "x-cockpit-secret". */
  headerName?: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const length = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length === bBytes.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export function requireSecret(req: Request, options: RequireSecretOptions): SecretCheck {
  const headerName = options.headerName ?? "x-cockpit-secret";
  const expected = Deno.env.get(options.envVar);

  if (!expected) {
    return {
      ok: false,
      motivo: "env_nao_configurada",
      detalhe: `require-secret: env var "${options.envVar}" não configurada — negando por padrão (fail-closed).`,
    };
  }

  const provided = req.headers.get(headerName);
  if (!provided) {
    return {
      ok: false,
      motivo: "segredo_ausente",
      detalhe: `require-secret: header "${headerName}" ausente.`,
    };
  }

  if (!timingSafeEqual(provided, expected)) {
    return {
      ok: false,
      motivo: "segredo_invalido",
      detalhe: `require-secret: header "${headerName}" não corresponde ao segredo configurado.`,
    };
  }

  return { ok: true };
}
