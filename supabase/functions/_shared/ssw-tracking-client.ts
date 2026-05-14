// AUTO-MIRROR de /lib/ssw-tracking-client.ts — não edite direto.
// Atualize /lib/ssw-tracking-client.ts e copie aqui antes do deploy.
//
// @deprecated Caio 2026-05-13 (plano "hoje-usamos-o-bastao", Fase 3):
// Tracking SSW público está sendo migrado pro scraping interno (opção 101)
// em ./ssw-internal-client.ts. Ver header do /lib/ssw-tracking-client.ts
// pra detalhes dos callers ainda em migração. Não criar novos callers.

const ENDPOINT = "https://ssw.inf.br/api/trackingpag";

export interface SswTrackingEnv {
  defaultSenha?: string;
  senhaByCnpj?: Record<string, string>;
}

export interface SswTrackingQuery {
  cnpjPagador: string;
  nroNf?: number | string;
  pedido?: string;
  chaveNfe?: string;
  nroColeta?: number | string;
  siglaEmp?: string;
  senha?: string;
}

export interface SswTrackingErrorResponse {
  success: false;
  message: string;
}

export interface SswTrackingSuccessResponse {
  success: true;
  [key: string]: unknown;
}

export type SswTrackingResponse = SswTrackingErrorResponse | SswTrackingSuccessResponse;

export interface SswTrackingFetchOptions {
  siglaEmp?: string;
  senhaOverride?: string;
}

export interface SswTrackingClient {
  fetchByNf(
    cnpjPagador: string,
    nroNf: number | string,
    opts?: SswTrackingFetchOptions,
  ): Promise<SswTrackingResponse>;
  fetchByChaveNfe(
    cnpjPagador: string,
    chave: string,
    opts?: SswTrackingFetchOptions,
  ): Promise<SswTrackingResponse>;
  fetchByPedido(
    cnpjPagador: string,
    pedido: string,
    opts?: SswTrackingFetchOptions,
  ): Promise<SswTrackingResponse>;
  fetchByColeta(
    cnpjPagador: string,
    nroColeta: number | string,
    opts?: SswTrackingFetchOptions,
  ): Promise<SswTrackingResponse>;
  query(q: SswTrackingQuery): Promise<SswTrackingResponse>;
}

export function readSswTrackingEnvFromProcess(
  env: Record<string, string | undefined>,
): SswTrackingEnv {
  const defaultSenha = env["SSW_TRACKING_SENHA_DEFAULT"];
  return {
    ...(defaultSenha ? { defaultSenha } : {}),
    senhaByCnpj: {},
  };
}

export function createSswTrackingClient(deps: {
  env: SswTrackingEnv;
  fetch?: typeof fetch;
}): SswTrackingClient {
  const f = deps.fetch ?? fetch;

  function senhaForCnpj(cnpj: string, override?: string): string | undefined {
    if (override !== undefined) return override;
    const normalized = cnpj.replace(/\D/g, "");
    return deps.env.senhaByCnpj?.[normalized] ?? deps.env.defaultSenha;
  }

  async function query(q: SswTrackingQuery): Promise<SswTrackingResponse> {
    const docLimpo = q.cnpjPagador.replace(/\D/g, "");
    if (docLimpo.length !== 11 && docLimpo.length !== 14) {
      throw new Error(
        `Documento do pagador inválido (esperado CPF/11 ou CNPJ/14 dígitos): "${q.cnpjPagador}"`,
      );
    }

    const hasIdentifier =
      q.nroNf != null || q.pedido != null || q.chaveNfe != null || q.nroColeta != null;
    if (!hasIdentifier) {
      throw new Error(
        "Pelo menos 1 identificador (nroNf, pedido, chaveNfe, nroColeta) obrigatório",
      );
    }

    const senha = senhaForCnpj(docLimpo, q.senha);

    const body: Record<string, unknown> = { cnpj: docLimpo };
    if (senha !== undefined) body["senha"] = senha;
    if (q.siglaEmp) body["sigla_emp"] = q.siglaEmp;
    if (q.nroNf != null) body["nro_nf"] = typeof q.nroNf === "string" ? parseInt(q.nroNf, 10) : q.nroNf;
    if (q.pedido != null) body["pedido"] = q.pedido;
    if (q.chaveNfe != null) body["chave_nfe"] = q.chaveNfe;
    if (q.nroColeta != null)
      body["nro_coleta"] = typeof q.nroColeta === "string" ? parseInt(q.nroColeta, 10) : q.nroColeta;

    const res = await f(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Resposta SSW tracking não é JSON: ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      throw new Error(`SSW tracking ${res.status}: ${text.slice(0, 200)}`);
    }

    return parsed as SswTrackingResponse;
  }

  return {
    query,
    fetchByNf(cnpjPagador, nroNf, opts) {
      const q: SswTrackingQuery = { cnpjPagador, nroNf };
      if (opts?.siglaEmp != null) q.siglaEmp = opts.siglaEmp;
      if (opts?.senhaOverride !== undefined) q.senha = opts.senhaOverride;
      return query(q);
    },
    fetchByChaveNfe(cnpjPagador, chave, opts) {
      const q: SswTrackingQuery = { cnpjPagador, chaveNfe: chave };
      if (opts?.siglaEmp != null) q.siglaEmp = opts.siglaEmp;
      if (opts?.senhaOverride !== undefined) q.senha = opts.senhaOverride;
      return query(q);
    },
    fetchByPedido(cnpjPagador, pedido, opts) {
      const q: SswTrackingQuery = { cnpjPagador, pedido };
      if (opts?.siglaEmp != null) q.siglaEmp = opts.siglaEmp;
      if (opts?.senhaOverride !== undefined) q.senha = opts.senhaOverride;
      return query(q);
    },
    fetchByColeta(cnpjPagador, nroColeta, opts) {
      const q: SswTrackingQuery = { cnpjPagador, nroColeta };
      if (opts?.siglaEmp != null) q.siglaEmp = opts.siglaEmp;
      if (opts?.senhaOverride !== undefined) q.senha = opts.senhaOverride;
      return query(q);
    },
  };
}

export function isTrackingSuccess(
  resp: SswTrackingResponse,
): resp is SswTrackingSuccessResponse {
  return resp.success === true;
}

/**
 * Lê tracking_credentials.ativo=true do Supabase e devolve map normalizado
 * (documento → senha) pra plugar em createSswTrackingClient.
 */
export async function loadTrackingSenhasFromSupabase(
  supabase: {
    from(table: string): {
      select(columns: string): {
        eq(column: string, value: unknown): Promise<{
          data: Array<{ documento: string; senha: string | null }> | null;
          error: { message: string } | null;
        }>;
      };
    };
  },
): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from("tracking_credentials")
    .select("documento, senha")
    .eq("ativo", true);

  if (error) {
    throw new Error(`Falha ao carregar tracking_credentials: ${error.message}`);
  }

  const map: Record<string, string> = {};
  for (const row of data ?? []) {
    if (row.senha != null) map[row.documento] = row.senha;
  }
  return map;
}
