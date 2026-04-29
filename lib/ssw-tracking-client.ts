/**
 * Cliente SSW Tracking (POST /api/trackingpag).
 *
 * Endpoint público por pagador — NÃO usa Bearer token da transportadora.
 * Cada pagador (cliente da Sal Express) tem CNPJ + senha próprios. A senha
 * é definida pela transportadora por cliente.
 *
 * Uso esperado:
 *   - Vinculador chama isso quando uma NF não está no Bastão (típico em NFs
 *     simuladas / não-atrasadas) e precisa popular dados do card a partir
 *     do SSW.
 *   - Operador (futuro) pode disparar uma "atualização" manual do card pra
 *     pegar status mais recente.
 *
 * Limitação: a Sal Express precisa cadastrar uma senha de tracking pra cada
 * CNPJ pagador que queremos consultar. Pra MVP de teste com Sal Express
 * própria como pagador, basta uma senha. Pra produção (clientes reais),
 * precisaremos de uma tabela `tracking_credentials` mapeando cnpj → senha.
 *
 * Doc: https://ssw.inf.br/ajuda/trackingpag.html
 */

const ENDPOINT = "https://ssw.inf.br/api/trackingpag";

export interface SswTrackingEnv {
  /** Senha default usada quando não houver senha específica pro CNPJ. */
  defaultSenha?: string;
  /**
   * Map CNPJ (14 dígitos) → senha. Permite registrar credenciais por cliente.
   * Lookup case-insensitive com strip de máscara antes de comparar.
   */
  senhaByCnpj?: Record<string, string>;
}

export interface SswTrackingQuery {
  /** CNPJ do pagador (14 dígitos, sem máscara). Obrigatório. */
  cnpjPagador: string;
  /** Pelo menos 1 dos 4 abaixo. */
  nroNf?: number | string;
  pedido?: string;
  chaveNfe?: string;
  nroColeta?: number | string;
  /** Filtro adicional opcional, ex: 'SEP'. */
  siglaEmp?: string;
  /** Override da senha (se vier de outra fonte que não env). */
  senha?: string;
}

/**
 * Resposta de erro do tracking. `success: false` + `message`.
 */
export interface SswTrackingErrorResponse {
  success: false;
  message: string;
}

/**
 * Resposta de sucesso. Os campos exatos não estão documentados oficialmente —
 * tipamos como `Record<string, unknown>` e o caller extrai o que precisa.
 *
 * Em testes empíricos (estimativa baseada no schema PostgREST do Bastão e
 * payloads similares do SSW), espera-se ao menos:
 *   - documento, serie, chave_nfe
 *   - remetente, destinatario, pagador (com CNPJ e nome)
 *   - cidade_origem, cidade_destino
 *   - peso, m3, frete
 *   - tracking[]: array de { codigo_ocorrencia, descricao, data, base }
 *
 * Quando tiver uma resposta real, atualizar este tipo pra concreto.
 */
export interface SswTrackingSuccessResponse {
  success: true;
  /** Provavel: dados da NF + array de ocorrências. */
  [key: string]: unknown;
}

export type SswTrackingResponse = SswTrackingErrorResponse | SswTrackingSuccessResponse;

export interface SswTrackingClient {
  fetchByNf(cnpjPagador: string, nroNf: number | string, opts?: SswTrackingFetchOptions): Promise<SswTrackingResponse>;
  fetchByChaveNfe(cnpjPagador: string, chave: string, opts?: SswTrackingFetchOptions): Promise<SswTrackingResponse>;
  fetchByPedido(cnpjPagador: string, pedido: string, opts?: SswTrackingFetchOptions): Promise<SswTrackingResponse>;
  fetchByColeta(cnpjPagador: string, nroColeta: number | string, opts?: SswTrackingFetchOptions): Promise<SswTrackingResponse>;
  /** Genérico — caller monta a query toda. */
  query(q: SswTrackingQuery): Promise<SswTrackingResponse>;
}

export interface SswTrackingFetchOptions {
  siglaEmp?: string;
  senhaOverride?: string;
}

/**
 * Lê env do SSW Tracking. `SSW_TRACKING_SENHA_DEFAULT` é a senha de fallback;
 * `SSW_TRACKING_CNPJ_DEFAULT` é metadata informativa, não usada pelo client.
 */
export function readSswTrackingEnvFromProcess(env: Record<string, string | undefined>): SswTrackingEnv {
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
    if (override) return override;
    const normalized = cnpj.replace(/\D/g, "");
    return deps.env.senhaByCnpj?.[normalized] ?? deps.env.defaultSenha;
  }

  async function query(q: SswTrackingQuery): Promise<SswTrackingResponse> {
    const cnpjLimpo = q.cnpjPagador.replace(/\D/g, "");
    if (cnpjLimpo.length !== 14) {
      throw new Error(`CNPJ do pagador inválido (esperado 14 dígitos): "${q.cnpjPagador}"`);
    }

    const hasIdentifier =
      q.nroNf != null || q.pedido != null || q.chaveNfe != null || q.nroColeta != null;
    if (!hasIdentifier) {
      throw new Error("Pelo menos 1 identificador (nroNf, pedido, chaveNfe, nroColeta) obrigatório");
    }

    const senha = senhaForCnpj(cnpjLimpo, q.senha);

    const body: Record<string, unknown> = { cnpj: cnpjLimpo };
    if (senha) body["senha"] = senha;
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
      if (opts?.senhaOverride != null) q.senha = opts.senhaOverride;
      return query(q);
    },
    fetchByChaveNfe(cnpjPagador, chave, opts) {
      const q: SswTrackingQuery = { cnpjPagador, chaveNfe: chave };
      if (opts?.siglaEmp != null) q.siglaEmp = opts.siglaEmp;
      if (opts?.senhaOverride != null) q.senha = opts.senhaOverride;
      return query(q);
    },
    fetchByPedido(cnpjPagador, pedido, opts) {
      const q: SswTrackingQuery = { cnpjPagador, pedido };
      if (opts?.siglaEmp != null) q.siglaEmp = opts.siglaEmp;
      if (opts?.senhaOverride != null) q.senha = opts.senhaOverride;
      return query(q);
    },
    fetchByColeta(cnpjPagador, nroColeta, opts) {
      const q: SswTrackingQuery = { cnpjPagador, nroColeta };
      if (opts?.siglaEmp != null) q.siglaEmp = opts.siglaEmp;
      if (opts?.senhaOverride != null) q.senha = opts.senhaOverride;
      return query(q);
    },
  };
}

/**
 * Type guard de sucesso pra caller usar com narrowing.
 */
export function isTrackingSuccess(
  resp: SswTrackingResponse,
): resp is SswTrackingSuccessResponse {
  return resp.success === true;
}
