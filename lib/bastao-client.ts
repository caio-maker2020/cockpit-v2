/**
 * Cliente HTTP de leitura do Bastão (Supabase externo de pendências).
 *
 * Usa PostgREST nativo do Supabase via fetch — sem dependência de
 * @supabase/supabase-js aqui pra manter a lib leve e testável.
 *
 * Read-only por design: o Cockpit nunca escreve no Bastão. Bastão é alimentado
 * pelo upstream do SSW (a cada ~40min) e mantido por outras áreas da Sal
 * Express. Nossa única interação é SELECT.
 *
 * Ver `docs/decisions/0004-cockpit-relacionamento-only.md` pra arquitetura.
 */

import {
  BASTAO_TEST_FILTER_OPERATOR,
  OCORRENCIAS_DE_RELACIONAMENTO,
} from "./bastao-rules.js";

/**
 * Schema da tabela `pendencias` do Bastão. Inclui só as colunas que o sync
 * usa — Bastão tem mais (val_merc, frete, m3, etc.) que ignoramos por ora.
 */
export interface BastaoPendencia {
  id: string;
  filial: string | null;
  ctrc: string | null;
  nf: string | null;
  cnpj_remetente: string | null;
  remetente: string | null;
  cnpj_pagador: string | null;
  pagador: string | null;
  cnpj_destinatario: string | null;
  destinatario: string | null;
  uf_destino: string | null;
  cidade_destino: string | null;
  base_destino: string | null;
  unidade_origem: string | null;
  unidade_destino: string | null;
  unidade_atual: string | null;
  cod_ultima_ocorrencia: number | null;
  instrucao_ultima_ocorrencia: string | null;
  data_ultima_ocorrencia: string | null; // ISO date
  responsabilidade_cliente: string | null; // 'NAO' | 'SIM'
  responsavel_atual: string | null;
  responsavel_relacionamento: string | null;
  atraso_original: number | null;
  previsao_entrega: string | null; // ISO date
  segmento_cliente: string | null;
  importante_acompanhar: boolean | null;
  created_at: string; // ISO timestamptz
  updated_at: string; // ISO timestamptz
}

export interface BastaoEnv {
  url: string;
  /** Anon key pra leitura. Service role só se RLS bloquear. */
  apiKey: string;
}

export interface BastaoClient {
  /** Pass A — discover: pendências cuja ocorrência atual é do Cockpit. */
  fetchPendenciasDoCockpit(opts?: { operadorFilter?: string | null }): Promise<BastaoPendencia[]>;
  /** Pass B — release / Pass C — verify: pega estado atual de uma pendência específica. */
  fetchPendenciaById(id: string): Promise<BastaoPendencia | null>;
  /** Vinculador: cliente mandou mensagem com NF X — busca no Bastão sem filtro. */
  fetchPendenciaByNf(nf: string): Promise<BastaoPendencia | null>;
  /** Vinculador: cliente mandou mensagem com CTRC X — busca no Bastão sem filtro. */
  fetchPendenciaByCtrc(ctrc: string): Promise<BastaoPendencia | null>;
}

export function readBastaoEnvFromProcess(env: Record<string, string | undefined>): BastaoEnv {
  const url = env["BASTAO_SUPABASE_URL"];
  const apiKey = env["BASTAO_SUPABASE_ANON_KEY"];

  if (!url) throw new Error("BASTAO_SUPABASE_URL não configurado");
  if (!apiKey) throw new Error("BASTAO_SUPABASE_ANON_KEY não configurado");

  return { url: url.replace(/\/+$/, ""), apiKey };
}

const SELECT_FIELDS = [
  "id",
  "filial",
  "ctrc",
  "nf",
  "cnpj_remetente",
  "remetente",
  "cnpj_pagador",
  "pagador",
  "cnpj_destinatario",
  "destinatario",
  "uf_destino",
  "cidade_destino",
  "base_destino",
  "unidade_origem",
  "unidade_destino",
  "unidade_atual",
  "cod_ultima_ocorrencia",
  "instrucao_ultima_ocorrencia",
  "data_ultima_ocorrencia",
  "responsabilidade_cliente",
  "responsavel_atual",
  "responsavel_relacionamento",
  "atraso_original",
  "previsao_entrega",
  "segmento_cliente",
  "importante_acompanhar",
  "created_at",
  "updated_at",
].join(",");

export function createBastaoClient(deps: {
  env: BastaoEnv;
  fetch?: typeof fetch;
}): BastaoClient {
  const f = deps.fetch ?? fetch;
  const headers = {
    apikey: deps.env.apiKey,
    Authorization: `Bearer ${deps.env.apiKey}`,
  } as const;

  async function get<T>(path: string): Promise<T> {
    const res = await f(`${deps.env.url}/rest/v1/${path}`, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bastão GET ${path} → ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  async function fetchPendenciasDoCockpit(opts?: {
    operadorFilter?: string | null;
  }): Promise<BastaoPendencia[]> {
    const codigos = Array.from(OCORRENCIAS_DE_RELACIONAMENTO).sort((a, b) => a - b).join(",");
    const filterOperador =
      opts?.operadorFilter !== undefined ? opts.operadorFilter : BASTAO_TEST_FILTER_OPERATOR;

    const params = new URLSearchParams();
    params.set("select", SELECT_FIELDS);
    params.set("cod_ultima_ocorrencia", `in.(${codigos})`);
    if (filterOperador) {
      params.set("responsavel_relacionamento", `eq.${filterOperador}`);
    }

    return get<BastaoPendencia[]>(`pendencias?${params.toString()}`);
  }

  async function fetchPendenciaById(id: string): Promise<BastaoPendencia | null> {
    const params = new URLSearchParams();
    params.set("select", SELECT_FIELDS);
    params.set("id", `eq.${id}`);
    params.set("limit", "1");
    const rows = await get<BastaoPendencia[]>(`pendencias?${params.toString()}`);
    return rows[0] ?? null;
  }

  async function fetchPendenciaByNf(nf: string): Promise<BastaoPendencia | null> {
    const params = new URLSearchParams();
    params.set("select", SELECT_FIELDS);
    params.set("nf", `eq.${nf}`);
    params.set("limit", "1");
    const rows = await get<BastaoPendencia[]>(`pendencias?${params.toString()}`);
    return rows[0] ?? null;
  }

  async function fetchPendenciaByCtrc(ctrc: string): Promise<BastaoPendencia | null> {
    const params = new URLSearchParams();
    params.set("select", SELECT_FIELDS);
    params.set("ctrc", `eq.${ctrc}`);
    params.set("limit", "1");
    const rows = await get<BastaoPendencia[]>(`pendencias?${params.toString()}`);
    return rows[0] ?? null;
  }

  return {
    fetchPendenciasDoCockpit,
    fetchPendenciaById,
    fetchPendenciaByNf,
    fetchPendenciaByCtrc,
  };
}
