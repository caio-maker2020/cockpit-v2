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
  tipo_documento: string | null;
  qtd_volumes: number | null;
  created_at: string;
  updated_at: string;
}

export interface BastaoEnv {
  url: string;
  apiKey: string;
}

export interface BastaoClient {
  fetchPendenciasDoCockpit(opts?: {
    cnpjsAllowlist?: string[] | null;
    excecoesOc13Cnpjs?: string[] | null;
    excecaoFullPull?: { segmentoPrefixos?: string[]; responsaveis?: string[] } | null;
    ocsExtras?: number[] | null;
  }): Promise<BastaoPendencia[]>;
  fetchPendenciaById(id: string): Promise<BastaoPendencia | null>;
  fetchPendenciasByIds(ids: string[]): Promise<BastaoPendencia[]>;
  /**
   * Caio 2026-06-19 (Pass B watermark): lookup em LOTE por NF — corta o N+1 do
   * Pass B. Para cada NF gera as 2 formas (sem zeros à esquerda + padded 9
   * dígitos, como fetchPendenciaByNf) num único `nf=in.(...)`. Chunk conservador.
   */
  fetchPendenciasByNfs(nfs: string[]): Promise<BastaoPendencia[]>;
  fetchPendenciaByNf(nf: string): Promise<BastaoPendencia | null>;
  /**
   * Caio 2026-06-24 (gate de frescor da aba EXTRAVIOS): maior `updated_at` da
   * tabela de pendências = heartbeat do RPA (que faz full-refresh a cada rodada).
   * Usado pra GARANTIR que a atualização do Bastão foi feita antes de inferir
   * "NF sumiu do relatório → finalizada → RESOLVIDO". Null se a tabela vier vazia.
   */
  fetchBastaoMaxUpdatedAt(): Promise<string | null>;
  fetchPendenciaByCtrc(ctrc: string): Promise<BastaoPendencia | null>;
  /**
   * Caio 2026-06-17: pull de EXTRAVIOS (oc 6/9/16 = resp. Perdas) restrito à
   * carteira de UM operador (aba EXTRAVIOS do Cockpit). Lista vazia → não puxa.
   */
  fetchExtraviosDoBastao(cnpjsAllowlist: string[]): Promise<BastaoPendencia[]>;
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
  "tipo_documento", "qtd_volumes",
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
    /**
     * Caio 2026-06-16 (allowlist por carteira): SÓ puxa pendências cujo
     * cnpj_pagador está nesta lista (= união das carteiras dos operadores
     * ativos). Substitui o filtro antigo por `operadores` (responsavel_
     * relacionamento). Cliente fora da allowlist NÃO entra no Cockpit (relaxa
     * INV-003 conscientemente). Allowlist VAZIA = não puxa nada. null/ausente =
     * comportamento legado (puxa todas as ocs de relacionamento, sem filtro).
     */
    cnpjsAllowlist?: string[] | null;
    /**
     * Caio 2026-05-19: CNPJs em cliente_config_oc13. Quando preenchido,
     * faz 2ª query Bastão pra puxar pendências oc=13 desses CNPJs (que não
     * caem no filtro normal de OCORRENCIAS_DE_RELACIONAMENTO). Resultados
     * concatenados ao set principal.
     */
    excecoesOc13Cnpjs?: string[] | null;
    /**
     * Caio 2026-06-16: EXCEÇÃO à allowlist por carteira. Operadores de "Curva F"
     * (ISA/Karol) tocam TODOS os clientes <20k/mês (muitos) — a planilha só
     * lista os de maior demanda. Pra eles, puxa 100% do que o Bastão aponta
     * como segmento Curva F (segmentoPrefixos=["043"]) OU responsável de exceção
     * (responsaveis=["ISA E KAROL"]), independente da allowlist. Concatenado +
     * dedup por id.
     */
    excecaoFullPull?: { segmentoPrefixos?: string[]; responsaveis?: string[] } | null;
    /**
     * Caio 2026-06-18 (ADR 0012, sync único): ocs extras a unir no pull além de
     * OCORRENCIAS_DE_RELACIONAMENTO — ex.: extravio [6,9,16]. Mesma filtragem por
     * allowlist/curvaF. O caller (sync-bastao) gateia pela flag extravios.
     */
    ocsExtras?: number[] | null;
  }): Promise<BastaoPendencia[]> {
    const codigos = Array.from(
      new Set([...OCORRENCIAS_DE_RELACIONAMENTO, ...(opts?.ocsExtras ?? [])]),
    ).sort((a, b) => a - b).join(",");
    const allowlist = opts?.cnpjsAllowlist ?? null;
    const excecoesCnpjs = opts?.excecoesOc13Cnpjs ?? null;

    const PAGE_SIZE = 1000;
    const all: BastaoPendencia[] = [];

    // Allowlist passada porém vazia (nenhum operador ativo com carteira) → não
    // puxa nada. Sem `in.()` vazio (que o PostgREST rejeita / puxaria tudo).
    if (allowlist && allowlist.length === 0) return all;

    // 1ª query: pendências normais (OCORRENCIAS_DE_RELACIONAMENTO), filtradas
    // por cnpj_pagador ∈ allowlist (chunked — a lista pode ter centenas de
    // CNPJs e estourar o tamanho da URL). Cada chunk é paginado por Range.
    const CNPJ_CHUNK = 150;
    const cnpjChunks: (string[] | null)[] = allowlist
      ? Array.from(
          { length: Math.ceil(allowlist.length / CNPJ_CHUNK) },
          (_, i) => allowlist.slice(i * CNPJ_CHUNK, (i + 1) * CNPJ_CHUNK),
        )
      : [null]; // null = sem filtro de cnpj (legado)

    for (const cnpjChunk of cnpjChunks) {
      let offset = 0;
      while (true) {
        const params = new URLSearchParams();
        params.set("select", SELECT_FIELDS);
        params.set("cod_ultima_ocorrencia", `in.(${codigos})`);
        if (cnpjChunk) {
          const lista = cnpjChunk.map((c) => c.replace(/,/g, "")).join(",");
          params.set("cnpj_pagador", `in.(${lista})`);
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
    }

    // 2ª query: exceção oc=13 dos CNPJs em cliente_config_oc13. Sem operadores
    // no filtro — qualquer card desses CNPJs interessa, resolver no Cockpit
    // re-atribui pelo CNPJ via carteira (resolverCamposAtribuicaoDoCard).
    if (excecoesCnpjs && excecoesCnpjs.length > 0) {
      const cnpjs = excecoesCnpjs.map((c) => c.replace(/,/g, "")).join(",");
      const params = new URLSearchParams();
      params.set("select", SELECT_FIELDS);
      params.set("cod_ultima_ocorrencia", "eq.13");
      params.set("cnpj_pagador", `in.(${cnpjs})`);
      try {
        const { data } = await get<BastaoPendencia[]>(
          `pendencias?${params.toString()}`,
          { Range: `0-${PAGE_SIZE - 1}`, Prefer: "count=exact" },
        );
        // Defesa contra duplicação caso uma NF cair nas 2 queries (raro mas
        // possível em corrida). Dedup por id (UUID Bastão).
        const seenIds = new Set<string>();
        for (const p of all) {
          if (p.id) seenIds.add(p.id);
        }
        for (const p of data) {
          if (!p.id || !seenIds.has(p.id)) all.push(p);
        }
      } catch (e) {
        console.warn(`[bastao-client] fetchPendenciasDoCockpit oc=13 exceção falhou: ${e instanceof Error ? e.message : String(e)} — segue só com pendências normais.`);
      }
    }

    // 3ª query (Caio 2026-06-16): EXCEÇÃO Curva F / ISA-Karol — puxa 100% do
    // que o Bastão aponta como segmento Curva F (043) OU responsável de exceção
    // (ISA E KAROL), independente da allowlist por carteira. O resolver do
    // Cockpit atribui pelo nome/segmento. Mesmo filtro de oc das pendências
    // normais (só relacionamento).
    const fp = opts?.excecaoFullPull ?? null;
    if (fp) {
      const filtros: Array<[string, string]> = [
        ...(fp.segmentoPrefixos ?? []).map((p) => ["segmento_cliente", `like.${p}*`] as [string, string]),
        ...(fp.responsaveis ?? []).map((r) => ["responsavel_relacionamento", `eq.${r}`] as [string, string]),
      ];
      for (const [campo, filtro] of filtros) {
        let offset = 0;
        while (true) {
          const params = new URLSearchParams();
          params.set("select", SELECT_FIELDS);
          params.set("cod_ultima_ocorrencia", `in.(${codigos})`);
          params.set(campo, filtro);
          try {
            const { data, contentRange } = await get<BastaoPendencia[]>(
              `pendencias?${params.toString()}`,
              { Range: `${offset}-${offset + PAGE_SIZE - 1}`, Prefer: "count=exact" },
            );
            all.push(...data);
            if (data.length < PAGE_SIZE) break;
            if (contentRange) {
              const total = parseInt(contentRange.split("/")[1] ?? "0", 10);
              if (offset + data.length >= total) break;
            }
            offset += PAGE_SIZE;
            if (offset > 50_000) break;
          } catch (e) {
            console.warn(`[bastao-client] fetchPendenciasDoCockpit excecaoFullPull ${campo}=${filtro} falhou: ${e instanceof Error ? e.message : String(e)}`);
            break;
          }
        }
      }
    }

    // Dedup final por id (allowlist + oc13 + fullPull podem sobrepor).
    const seenFinal = new Set<string>();
    const deduped: BastaoPendencia[] = [];
    for (const p of all) {
      if (p.id) {
        if (seenFinal.has(p.id)) continue;
        seenFinal.add(p.id);
      }
      deduped.push(p);
    }
    return deduped;
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

  async function fetchPendenciasByNfs(nfs: string[]): Promise<BastaoPendencia[]> {
    if (nfs.length === 0) return [];
    // Chunk de 50 NFs → até 100 valores no in.() (2 formas por NF). Conservador
    // pra não estourar o tamanho da URL do PostgREST do Bastão.
    const CHUNK_SIZE = 50;
    const out: BastaoPendencia[] = [];
    for (let i = 0; i < nfs.length; i += CHUNK_SIZE) {
      const chunk = nfs.slice(i, i + CHUNK_SIZE);
      const formas = new Set<string>();
      for (const nf of chunk) {
        const nfNorm = String(nf).replace(/^0+/, "");
        if (!nfNorm) continue;
        formas.add(nfNorm);
        formas.add(nfNorm.padStart(9, "0"));
      }
      if (formas.size === 0) continue;
      const params = new URLSearchParams();
      params.set("select", SELECT_FIELDS);
      params.set("nf", `in.(${[...formas].join(",")})`);
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

  // Caio 2026-06-17: EXTRAVIOS (oc 6/9/16) da carteira de UM operador (Duilio no
  // teste). Mesmo chunk+paginação de fetchPendenciasDoCockpit, mas ocs de Perdas.
  async function fetchExtraviosDoBastao(cnpjsAllowlist: string[]): Promise<BastaoPendencia[]> {
    if (!cnpjsAllowlist || cnpjsAllowlist.length === 0) return [];
    const PAGE_SIZE = 1000;
    const CNPJ_CHUNK = 150;
    const all: BastaoPendencia[] = [];
    const chunks = Array.from(
      { length: Math.ceil(cnpjsAllowlist.length / CNPJ_CHUNK) },
      (_, i) => cnpjsAllowlist.slice(i * CNPJ_CHUNK, (i + 1) * CNPJ_CHUNK),
    );
    for (const chunk of chunks) {
      let offset = 0;
      while (true) {
        const params = new URLSearchParams();
        params.set("select", SELECT_FIELDS);
        params.set("cod_ultima_ocorrencia", "in.(6,9,16)");
        params.set("cnpj_pagador", `in.(${chunk.map((c) => c.replace(/,/g, "")).join(",")})`);
        const { data, contentRange } = await get<BastaoPendencia[]>(
          `pendencias?${params.toString()}`,
          { Range: `${offset}-${offset + PAGE_SIZE - 1}`, Prefer: "count=exact" },
        );
        all.push(...data);
        if (data.length < PAGE_SIZE) break;
        if (contentRange) {
          const total = parseInt(contentRange.split("/")[1] ?? "0", 10);
          if (offset + data.length >= total) break;
        }
        offset += PAGE_SIZE;
        if (offset > 50_000) break;
      }
    }
    const seen = new Set<string>();
    const out: BastaoPendencia[] = [];
    for (const p of all) {
      if (p.id) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
      }
      out.push(p);
    }
    return out;
  }

  async function fetchBastaoMaxUpdatedAt(): Promise<string | null> {
    const rows = await getJson<Array<{ updated_at: string | null }>>(
      "pendencias?select=updated_at&order=updated_at.desc&limit=1",
    );
    return rows[0]?.updated_at ?? null;
  }

  return {
    fetchPendenciasDoCockpit,
    fetchPendenciaById,
    fetchPendenciasByIds,
    fetchPendenciasByNfs,
    fetchPendenciaByNf,
    fetchPendenciaByCtrc,
    fetchExtraviosDoBastao,
    fetchBastaoMaxUpdatedAt,
  };
}
