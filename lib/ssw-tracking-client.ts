/**
 * Cliente SSW Tracking (POST /api/trackingpag).
 *
 * @deprecated Caio 2026-05-13 (plano "hoje-usamos-o-bastao", Fase 3):
 *
 * Tracking SSW público está sendo descontinuado em favor do scraping interno
 * via opção 101 ([supabase/functions/_shared/ssw-internal-client.ts]) que
 * cobre TODAS as ocorrências (público oculta 31 ocs: 49/56/44/30/31/...) e
 * retorna números canônicos do portal logado (público às vezes diverge).
 *
 * Callers ainda em migração (não usar em código novo):
 *   - sync-bastao Pass B (releaseCardViaTracking) — crosscheck quando NF
 *     some do Bastão; planejado migrar pra ssw-internal-client.
 *   - sync-bastao Pass E — tracking pra cards em AGUARDANDO_CLIENTE.
 *   - vinculador — resolve dados quando NF não está no Bastão.
 *
 * Callers já migrados:
 *   - voltar-para-to-do-com-rastreio v3 (2026-05-13)
 *   - atualizar-card-via-tracking (2026-05-12)
 *
 * Não criar novos callers. Quando o último for migrado, remover este arquivo
 * e o mirror em supabase/functions/_shared/.
 *
 * --- doc original abaixo ---
 *
 * Endpoint público por pagador — NÃO usa Bearer token da transportadora.
 * Cada pagador (cliente da Sal Express) tem CNPJ + senha próprios. A senha
 * é definida pela transportadora por cliente.
 *
 * Limitação histórica: a Sal Express precisa cadastrar uma senha de tracking
 * pra cada CNPJ pagador que queremos consultar. Limitação resolvida no
 * scraping interno (que loga como Sal — vê tudo).
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
  /**
   * Documento do pagador — CPF (11 dígitos) ou CNPJ (14 dígitos), sem máscara.
   * Aceita máscara também (vai ser sanitizada). Obrigatório.
   * Mantém o nome `cnpjPagador` por compat retro; semanticamente é PJ ou PF.
   */
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
    const docLimpo = q.cnpjPagador.replace(/\D/g, "");
    // SSW trackingpag aceita CPF (11) ou CNPJ (14). PJ ou PF como pagador.
    if (docLimpo.length !== 11 && docLimpo.length !== 14) {
      throw new Error(
        `Documento do pagador inválido (esperado CPF/11 ou CNPJ/14 dígitos): "${q.cnpjPagador}"`,
      );
    }

    const hasIdentifier =
      q.nroNf != null || q.pedido != null || q.chaveNfe != null || q.nroColeta != null;
    if (!hasIdentifier) {
      throw new Error("Pelo menos 1 identificador (nroNf, pedido, chaveNfe, nroColeta) obrigatório");
    }

    const senha = senhaForCnpj(docLimpo, q.senha);

    const body: Record<string, unknown> = { cnpj: docLimpo };
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

/**
 * Lê senhas de tracking da tabela `public.tracking_credentials` e devolve
 * um map cnpj/cpf → senha pra ser usado em `createSswTrackingClient`.
 *
 * Usa o cliente Supabase passado pelo caller (esperado: service_role pra
 * bypassar RLS). Filtra apenas `ativo=true`.
 *
 * Tipo do supabase deliberadamente loose (qualquer cliente que tenha
 * `.from(...).select(...)` compatível) — evita import direto do
 * @supabase/supabase-js no lib/ pra mantê-lo Bun-testável.
 */
export interface SupabaseLikeForTracking {
  from(table: string): {
    select(columns: string): Promise<{
      data: Array<{ documento: string; senha: string | null }> | null;
      error: { message: string } | null;
    }>;
  };
}

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
