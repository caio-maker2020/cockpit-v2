// =============================================================================
// import-chaves-cte — recebe CSV do relatório OPC 455 (gerado pelo SSW) e
// popula public.nf_chave_cte.
//
// Aceita o CSV CRU do SSW sem precisar adaptação no RPA. Faz a sanitização
// no servidor:
//   - Strip de caractere "†" (marca de fim de campo do SSW)
//   - Data BR "DD/MM/AAAA" → ISO "AAAA-MM-DD"
//   - NF com leading zeros → strip
//   - CNPJ/CPF: strip de máscara (só dígitos)
//   - Cabeçalho exato do 455: "Serie/Numero CTRC", "Chave CT-e",
//     "Numero da Nota Fiscal", "CNPJ Pagador", "Data de Emissao"
//
// Uso: POST com Content-Type: text/csv, body = arquivo CSV cru.
// Auth: Authorization: Bearer <SERVICE_ROLE_KEY>
//
// Retorno:
//   { received, inserted, skipped_duplicates, skipped_invalid, errors[] }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Edge Functions têm limite de CPU/memória. 200 rows por upsert mantém
// folga e processa em <2s por batch. Caller (script Python) deve mandar
// CSV de até ~1000 linhas por POST — vai gerar 5 upserts internos.
const BATCH_SIZE = 200;

interface ParsedRow {
  ctrc: string | null;
  chave_cte: string;
  nf: string;
  cnpj_pagador: string;
  data_emissao: string | null;
  import_session?: string | null;
}

interface ImportSummary {
  received: number;
  inserted: number;
  skipped_invalid: number;
  errors: Array<{ line: number; message: string; raw: string }>;
  duration_ms: number;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

serve(async (req) => {
  const startedAt = Date.now();

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    let csvText = await req.text();
    if (!csvText.trim()) {
      return jsonResponse(400, { error: "Body vazio" });
    }

    // BOM UTF-8 (﻿) no início quebra parsing. Algumas exportações do
    // Excel/SSW incluem. Strip.
    if (csvText.charCodeAt(0) === 0xfeff) {
      csvText = csvText.slice(1);
    }

    // Header opcional X-Import-Session: ID único da execução do RPA. Quando
    // presente, cada row inserida é tageada com esse session_id. Após RPA
    // terminar todos os batches, chama /finalize-import-chaves que apaga
    // todos os sessions != current. Isso é o full-replace seguro.
    const importSession = req.headers.get("x-import-session") ?? null;

    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      return jsonResponse(400, {
        error: "CSV precisa de pelo menos 1 linha de cabeçalho + 1 de dados",
      });
    }

    // Auto-detecta separador: SSW BR exporta com ";" mas CSVs gerados em
    // outras stacks usam ",". Conta na primeira linha qual aparece mais.
    const delimiter: "," | ";" =
      (lines[0]!.match(/;/g)?.length ?? 0) > (lines[0]!.match(/,/g)?.length ?? 0)
        ? ";"
        : ",";

    const header = parseCsvLine(lines[0]!, delimiter);
    let colMap: Record<string, number>;
    try {
      colMap = mapHeader(header);
    } catch (mapErr) {
      const msg = mapErr instanceof Error ? mapErr.message : String(mapErr);
      return jsonResponse(400, {
        error: msg,
        debug: {
          delimiter_detectado: delimiter,
          cabecalho_recebido: header,
          cabecalho_raw: lines[0]!.slice(0, 500),
          primeira_linha_dados: lines[1]?.slice(0, 500),
        },
      });
    }

    const summary: ImportSummary = {
      received: lines.length - 1,
      inserted: 0,
      skipped_invalid: 0,
      errors: [],
      duration_ms: 0,
    };

    const valid: ParsedRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const lineNum = i + 1;
      const fields = parseCsvLine(lines[i]!, delimiter);
      try {
        const row = buildRow(fields, colMap);
        if (row) {
          if (importSession) row.import_session = importSession;
          valid.push(row);
        } else {
          summary.skipped_invalid++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.errors.push({ line: lineNum, message: msg, raw: lines[i]!.slice(0, 200) });
        summary.skipped_invalid++;
      }
    }

    // Bulk upsert com ON CONFLICT (chave_cte) DO UPDATE — quando chave já
    // existe, atualiza import_session (e demais campos, idempotente porque
    // chave fiscal é imutável). Isso permite que o /finalize identifique
    // quais chaves vieram no run atual vs runs anteriores.
    for (let i = 0; i < valid.length; i += BATCH_SIZE) {
      const batch = valid.slice(i, i + BATCH_SIZE);
      const { error: insErr, count } = await supabase
        .from("nf_chave_cte")
        .upsert(batch, { onConflict: "chave_cte", ignoreDuplicates: false, count: "exact" });
      if (insErr) {
        summary.errors.push({
          line: i + 2,
          message: `bulk insert: ${insErr.message}`,
          raw: `batch ${i}-${i + batch.length}`,
        });
      } else if (count != null) {
        summary.inserted += count;
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    console.log("import-chaves-cte:", JSON.stringify(summary));
    return jsonResponse(200, summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("import-chaves-cte fatal:", msg);
    return jsonResponse(500, { error: msg, duration_ms: Date.now() - startedAt });
  }
});

// =============================================================================

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Parse simples de linha CSV. Suporta campos com delimiter em aspas duplas.
 * Aceita delimitador "," (default — global) ou ";" (BR padrão Excel/SSW).
 */
function parseCsvLine(line: string, delimiter: "," | ";" = ","): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (c === delimiter && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/**
 * Header esperado do OPC 455 (case-insensitive, com leniência de espaços):
 *   "Serie/Numero CTRC", "Chave CT-e", "Numero da Nota Fiscal",
 *   "CNPJ Pagador", "Data de Emissao"
 */
function mapHeader(header: string[]): Record<string, number> {
  // Normaliza pra comparação tolerante:
  //  - lowercase
  //  - remove acentos (Á → a, é → e)
  //  - hífens unicode (‐ – — ‒ −) viram hífen ASCII (-)
  //  - espaços múltiplos viram 1 só
  //  - remove † (marcador SSW)
  //  - strip aspas
  const norm = (s: string) =>
    s.toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // remove combining diacritics
      .replace(/[‐‑‒–—―−]/g, "-") // hífens unicode → -
      .replace(/[ ]/g, " ") // nbsp → space
      .replace(/\s+/g, " ")
      .replace(/[†"']/g, "")
      .trim();

  const indexed = header.map(norm);

  function find(...candidates: string[]): number {
    for (const c of candidates) {
      const cn = norm(c);
      const i = indexed.findIndex((h) => h === cn);
      if (i >= 0) return i;
    }
    return -1;
  }

  const map: Record<string, number> = {
    ctrc: find("serie/numero ctrc", "ctrc", "serie numero ctrc"),
    chave_cte: find("chave ct-e", "chave cte", "chave_cte"),
    nf: find("numero da nota fiscal", "nf", "numero nf", "nro nf"),
    cnpj_pagador: find("cnpj pagador", "cnpj_pagador", "documento pagador"),
    data_emissao: find("data de emissao", "data emissao", "data_emissao"),
  };

  // Validação: campos obrigatórios
  if (map["chave_cte"] < 0) {
    throw new Error('Coluna obrigatória "Chave CT-e" não encontrada no cabeçalho');
  }
  if (map["nf"] < 0) {
    throw new Error('Coluna obrigatória "Numero da Nota Fiscal" não encontrada');
  }
  if (map["cnpj_pagador"] < 0) {
    throw new Error('Coluna obrigatória "CNPJ Pagador" não encontrada');
  }

  return map;
}

function buildRow(fields: string[], colMap: Record<string, number>): ParsedRow | null {
  const get = (key: string): string => {
    const idx = colMap[key]!;
    if (idx < 0 || idx >= fields.length) return "";
    return fields[idx]!;
  };

  const chaveCteRaw = sanitizeDigits(get("chave_cte"));
  if (chaveCteRaw.length !== 44) {
    // Sem chave válida não dá pra inserir (PRIMARY KEY exige 44 dígitos)
    return null;
  }

  const nfRaw = sanitizeDigits(get("nf")).replace(/^0+/, "");
  if (!nfRaw) return null;

  const cnpjPagadorRaw = sanitizeDigits(get("cnpj_pagador"));
  if (cnpjPagadorRaw.length !== 11 && cnpjPagadorRaw.length !== 14) return null;

  const ctrcRaw = clean(get("ctrc"));
  const dataRaw = clean(get("data_emissao"));

  return {
    ctrc: ctrcRaw || null,
    chave_cte: chaveCteRaw,
    nf: nfRaw,
    cnpj_pagador: cnpjPagadorRaw,
    data_emissao: parseDataBr(dataRaw),
  };
}

/**
 * Limpa marcador "†" e espaços. Mantém demais caracteres.
 */
function clean(s: string): string {
  return s.replace(/†/g, "").trim();
}

/**
 * Mantém só dígitos.
 */
function sanitizeDigits(s: string): string {
  return s.replace(/\D/g, "");
}

/**
 * Converte data brasileira (DD/MM/AAAA ou DD/MM/AA) → ISO YYYY-MM-DD.
 * Aceita também já em formato ISO (passa direto).
 * Retorna null se não conseguir parsear.
 */
function parseDataBr(s: string): string | null {
  const cleaned = s.replace(/†/g, "").trim();
  if (!cleaned) return null;

  // Já está em ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

  // DD/MM/AAAA ou DD/MM/AA
  const m = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const dd = m[1]!.padStart(2, "0");
  const mm = m[2]!.padStart(2, "0");
  let yy = m[3]!;
  if (yy.length === 2) {
    // Heurística: 00-49 = 2000s; 50-99 = 1900s
    const n = parseInt(yy, 10);
    yy = n < 50 ? `20${yy}` : `19${yy}`;
  }
  return `${yy}-${mm}-${dd}`;
}
