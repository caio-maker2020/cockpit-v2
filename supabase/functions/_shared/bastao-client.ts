// AUTO-MIRROR de /lib/bastao-client.ts — não edite direto.
// Atualize /lib/bastao-client.ts e copie aqui antes do deploy.

import {
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
  fetchPendenciasDoCockpit(opts?: {
    operadores?: string[] | null;
  }): Promise<BastaoPendencia[]>;
  fetchPendenciaById(id: string): Promise<BastaoPendencia | null>;
  fetchPendenciasByIds(ids: string[]): Promise<BastaoPendencia[]>;
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

  async function get<T>(path: string, extraHeaders?: Record<string, string>): Promise<{ data: T; contentRange: string | null }> {
    const res = await f(`${deps.env.url}/rest/v1/${path}`, {
      headers: { ...headers, ...(extraHeaders ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bastão GET ${path} → ${res.status}: ${body}`);
    }
    return {
      data: (await res.json()) as T,
      contentRange: res.headers.get("content-range"),
    };
  }

  async function getJson<T>(path: string): Promise<T> {
    const { data } = await get<T>(path);
    return data;
  }

  /**
   * Camada 5c+5d: aceita lista de operadores (responsavel_relacionamento)
   * e pagina explicitamente via Range header até esgotar. Sem hardcode
   * de operador único; sem risco de truncamento em 1000 rows.
   */
  async function fetchPendenciasDoCockpit(opts?: {
    operadores?: string[] | null;
  }): Promise<BastaoPendencia[]> {
    const codigos = Array.from(OCORRENCIAS_DE_RELACIONAMENTO).sort((a, b) => a - b).join(",");
    const operadores = opts?.operadores ?? null;

    const PAGE_SIZE = 1000;
    const all: BastaoPendencia[] = [];
    let offset = 0;

    while (true) {
      const params = new URLSearchParams();
      params.set("select", SELECT_FIELDS);
      params.set("cod_ultima_ocorrencia", `in.(${codigos})`);
      if (operadores && operadores.length > 0) {
        // PostgREST: responsavel_relacionamento=in.(A,B,C)
        const lista = operadores.map((o) => o.replace(/,/g, "")).join(",");
        params.set("responsavel_relacionamento", `in.(${lista})`);
      }

      const { data, contentRange } = await get<BastaoPendencia[]>(
        `pendencias?${params.toString()}`,
        {
          Range: `${offset}-${offset + PAGE_SIZE - 1}`,
          Prefer: "count=exact",
        },
      );

      all.push(...data);

      if (data.length < PAGE_SIZE) break;

      // content-range: "0-999/1172" — pega total e decide parar
      if (contentRange) {
        const total = parseInt(contentRange.split("/")[1] ?? "0", 10);
        if (offset + data.length >= total) break;
      }

      offset += PAGE_SIZE;
      // Hard cap pra evitar loop infinito se Postgrest devolver algo estranho
      if (offset > 50_000) {
        console.warn(`[bastao-client] fetchPendenciasDoCockpit: hit cap 50000 rows`);
        break;
      }
    }

    return all;
  }

  async function fetchPendenciaById(id: string): Promise<BastaoPendencia | null> {
    const params = new URLSearchParams();
    params.set("select", SELECT_FIELDS);
    params.set("id", `eq.${id}`);
    params.set("limit", "1");
    const rows = await getJson<BastaoPendencia[]>(`pendencias?${params.toString()}`);
    return rows[0] ?? null;
  }

  async function fetchPendenciasByIds(ids: string[]): Promise<BastaoPendencia[]> {
    if (ids.length === 0) return [];
    const CHUNK_SIZE = 80;
    const out: BastaoPendencia[] = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const params = new URLSearchParams();
      params.set("select", SELECT_FIELDS);
      params.set("id", `in.(${chunk.join(",")})`);
      const rows = await getJson<BastaoPendencia[]>(`pendencias?${params.toString()}`);
      out.push(...rows);
    }
    return out;
  }

  async function fetchPendenciaByNf(nf: string): Promise<BastaoPendencia | null> {
    // Caio 2026-05-08: Cockpit guarda NF sem zeros à esquerda ("69866"),
    // Bastão guarda com padding 9 dígitos ("000069866"). Match exato falhava
    // e cards em ACAO_EXECUTADA ficavam presos (Pass G nunca confirmava
    // Bastão). Usa OR pra cobrir os 2 formatos.
    const nfNorm = String(nf).replace(/^0+/, "");
    const nfPadded = nfNorm.padStart(9, "0");
    const params = new URLSearchParams();
    params.set("select", SELECT_FIELDS);
    params.set("or", `(nf.eq.${nfNorm},nf.eq.${nfPadded})`);
    params.set("limit", "1");
    const rows = await getJson<BastaoPendencia[]>(`pendencias?${params.toString()}`);
    return rows[0] ?? null;
  }

  async function fetchPendenciaByCtrc(ctrc: string): Promise<BastaoPendencia | null> {
    const params = new URLSearchParams();
    params.set("select", SELECT_FIELDS);
    params.set("ctrc", `eq.${ctrc}`);
    params.set("limit", "1");
    const rows = await getJson<BastaoPendencia[]>(`pendencias?${params.toString()}`);
    return rows[0] ?? null;
  }

  return {
    fetchPendenciasDoCockpit,
    fetchPendenciaById,
    fetchPendenciasByIds,
    fetchPendenciaByNf,
    fetchPendenciaByCtrc,
  };
}
