// AUTO-MIRROR de /lib/bastao-client.ts — não edite direto.
// Atualize /lib/bastao-client.ts e copie aqui antes do deploy.

import {
  BASTAO_TEST_FILTER_OPERATOR,
  OCORRENCIAS_DE_RELACIONAMENTO,
} from "./bastao-rules.ts";

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
  data_ultima_ocorrencia: string | null;
  responsabilidade_cliente: string | null;
  responsavel_atual: string | null;
  responsavel_relacionamento: string | null;
  atraso_original: number | null;
  previsao_entrega: string | null;
  segmento_cliente: string | null;
  importante_acompanhar: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface BastaoEnv {
  url: string;
  apiKey: string;
}

export interface BastaoClient {
  fetchPendenciasDoCockpit(opts?: { operadorFilter?: string | null }): Promise<BastaoPendencia[]>;
  fetchPendenciaById(id: string): Promise<BastaoPendencia | null>;
  fetchPendenciaByNf(nf: string): Promise<BastaoPendencia | null>;
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
  "created_at", "updated_at",
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
