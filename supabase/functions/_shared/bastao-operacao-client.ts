// =============================================================================
// bastao-operacao-client — a fila da Operação lida do Bastão (ADR 0041, D4).
//
// É o MESMO BastaoClient de hoje (createBastaoClient, mesmo env, mesma tabela
// `pendencias`, mesmo tipo BastaoPendencia) com UM método a mais:
// `fetchPendenciasDaOperacao`. Ele fica neste arquivo, e não em
// bastao-client.ts, porque aquele é espelho de lib/bastao-client.ts e está
// pinado byte a byte (ponte-operacao-flags-off.test.ts): a Operação não encosta
// no que o Relacionamento já roda. Quando o Bastão novo chegar, só este
// adaptador muda; o materializador depende da interface, não do REST.
//
// Filtro, igual à hierarquia do `state_pelo_bastao` (mig 029):
//   responsavel_atual = 'operacao'  OU  (responsavel_atual vazio E oc ∈ códigos
//   de responsabilidade 'Operação' do ocorrencias_dicionario).
// O materializador confere de novo (ehDaOperacao) — o filtro aqui só economiza
// banda. Paginação por Range, como o fetchPendenciasDoCockpit.
// =============================================================================

import {
  type BastaoClient,
  type BastaoEnv,
  type BastaoPendencia,
  createBastaoClient,
} from "./bastao-client.ts";

export interface BastaoOperacaoClient extends BastaoClient {
  /**
   * Pendências da Operação. `completo=false` quando uma página falhou no meio:
   * o materializador NÃO encerra item nenhum por "sumiu" numa leitura incompleta.
   */
  fetchPendenciasDaOperacao(opts: { codigosOperacao: readonly number[] }): Promise<{
    pendencias: BastaoPendencia[];
    completo: boolean;
    erro: string | null;
  }>;
}

/** Mesmos campos do SELECT do bastao-client (o tipo BastaoPendencia). */
export const CAMPOS_PENDENCIA_OPERACAO = [
  "id", "filial", "ctrc", "nf",
  "cnpj_remetente", "remetente",
  "cnpj_pagador", "pagador",
  "cnpj_destinatario", "destinatario",
  "uf_destino", "cidade_destino", "base_destino",
  "unidade_origem", "unidade_destino", "unidade_atual",
  "cod_ultima_ocorrencia", "instrucao_ultima_ocorrencia",
  "data_ultima_ocorrencia",
  "responsabilidade_cliente",
  "responsavel_atual", "responsavel_relacionamento",
  "atraso_original", "previsao_entrega",
  "segmento_cliente", "importante_acompanhar",
  "tipo_documento", "qtd_volumes",
  "created_at", "updated_at",
].join(",");

export const PAGINA_BASTAO = 1000;
export const TETO_LINHAS_BASTAO = 50_000;

/** Pura: o filtro PostgREST `or=(...)` da Operação. */
export function filtroOperacao(codigosOperacao: readonly number[]): string {
  const codigos = [...new Set(codigosOperacao.filter((c) => Number.isInteger(c) && c > 0))].sort((a, b) => a - b);
  const porResp = "responsavel_atual.eq.operacao";
  if (codigos.length === 0) return `(${porResp})`;
  return `(${porResp},and(responsavel_atual.is.null,cod_ultima_ocorrencia.in.(${codigos.join(",")})))`;
}

export function createBastaoOperacaoClient(deps: { env: BastaoEnv; fetch?: typeof fetch }): BastaoOperacaoClient {
  const f = deps.fetch ?? fetch;
  const base = createBastaoClient({ env: deps.env, fetch: f });
  const headers = { apikey: deps.env.apiKey, Authorization: `Bearer ${deps.env.apiKey}` } as const;

  async function fetchPendenciasDaOperacao(opts: { codigosOperacao: readonly number[] }) {
    const pendencias: BastaoPendencia[] = [];
    let offset = 0;
    while (true) {
      const params = new URLSearchParams();
      params.set("select", CAMPOS_PENDENCIA_OPERACAO);
      params.set("or", filtroOperacao(opts.codigosOperacao));
      params.set("order", "id.asc");
      let res: Response;
      try {
        res = await f(`${deps.env.url}/rest/v1/pendencias?${params.toString()}`, {
          headers: { ...headers, Range: `${offset}-${offset + PAGINA_BASTAO - 1}`, Prefer: "count=exact" },
        });
      } catch (e) {
        return { pendencias, completo: false, erro: `rede: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (!res.ok) {
        return { pendencias, completo: false, erro: `Bastão ${res.status}: ${(await res.text()).slice(0, 300)}` };
      }
      const data = (await res.json()) as BastaoPendencia[];
      pendencias.push(...data);
      if (data.length < PAGINA_BASTAO) break;
      const cr = res.headers.get("content-range");
      if (cr) {
        const total = parseInt(cr.split("/")[1] ?? "0", 10);
        if (Number.isFinite(total) && offset + data.length >= total) break;
      }
      offset += PAGINA_BASTAO;
      if (offset >= TETO_LINHAS_BASTAO) {
        return { pendencias, completo: false, erro: `teto de ${TETO_LINHAS_BASTAO} linhas atingido` };
      }
    }
    return { pendencias, completo: true, erro: null };
  }

  return { ...base, fetchPendenciasDaOperacao };
}
