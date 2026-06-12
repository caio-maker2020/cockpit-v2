// =============================================================================
// alterar-especie-cliente-lote — aplica/audita espécie em LOTE (opção 382)
//
// Limitação sistêmica SSW = 1 cliente por vez, mas aqui reusamos UMA sessão de
// login (obterSessao cacheia no warm instance) pra muitos clientes por chamada,
// dentro de um orçamento de tempo (Supabase corta edge em ~150s). Quando o
// orçamento acaba, retorna `pendentes` pro caller reinvocar com o restante.
//
// Modos:
//   "aplicar"  → alterarEspecieCliente(cnpj, codigos) por linha (idempotente)
//   "auditar"  → lerEspecieCliente(cnpj) por linha; só confirma estado, não grava
//
// Auth: JWT verificado. Input POST JSON:
//   { "cnpjs": ["..."], "codigos": ["043"], "mode": "aplicar"|"auditar",
//     "budgetMs"?: 110000, "operador"?: "LARISSA" }
// Output: { mode, processados:[...], pendentes:[...], resumo:{...} }
// =============================================================================

import {
  readSswInternalEnv,
  alterarEspecieCliente,
  lerEspecieCliente,
} from "../_shared/ssw-internal-client.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return j({ ok: false, erro: "POST only" }, 405);
  const env = Deno.env.toObject();
  const t0 = Date.now();

  let body: {
    cnpjs?: string[];
    codigos?: string[];
    mode?: string;
    budgetMs?: number;
    operador?: string;
  };
  try {
    body = await req.json();
  } catch {
    return j({ ok: false, erro: "bad json" }, 400);
  }

  const cnpjs = Array.isArray(body.cnpjs)
    ? body.cnpjs.map((c) => String(c).replace(/\D/g, "")).filter(Boolean)
    : [];
  const codigos = Array.isArray(body.codigos) ? body.codigos.map(String) : ["043"];
  const mode = body.mode === "auditar" ? "auditar" : "aplicar";
  const budgetMs = typeof body.budgetMs === "number" ? body.budgetMs : 110_000;

  if (cnpjs.length === 0) return j({ ok: false, erro: "cnpjs obrigatório (array)" }, 400);

  let sswEnv;
  try {
    sswEnv = readSswInternalEnv(env, body.operador ?? null);
  } catch (err) {
    return j({ ok: false, erro: err instanceof Error ? err.message : String(err) }, 500);
  }

  const processados: unknown[] = [];
  const pendentes: string[] = [];

  for (let i = 0; i < cnpjs.length; i++) {
    // Reserva ~6s de folga pro response não estourar o timeout
    if (Date.now() - t0 > budgetMs) {
      pendentes.push(...cnpjs.slice(i));
      break;
    }
    const cnpj = cnpjs[i]!;
    try {
      if (mode === "auditar") {
        const r = await lerEspecieCliente(sswEnv, cnpj);
        processados.push({
          cnpj,
          cliente: r.cliente,
          marcados: r.marcados,
          encontrado: r.encontrado,
          conforme: r.marcados.length === 1 && codigos.includes(r.marcados[0]!),
        });
      } else {
        const r = await alterarEspecieCliente(sswEnv, cnpj, codigos);
        processados.push(r);
      }
    } catch (err) {
      processados.push({
        ok: false,
        cnpj,
        erro: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const resumo = resumir(mode, processados);
  return j({
    mode,
    codigos,
    total_recebido: cnpjs.length,
    processados_count: processados.length,
    pendentes_count: pendentes.length,
    elapsed_ms: Date.now() - t0,
    resumo,
    processados,
    pendentes,
  }, 200);
});

function resumir(mode: string, rows: unknown[]) {
  if (mode === "auditar") {
    const r = rows as Array<{ conforme?: boolean; encontrado?: boolean }>;
    return {
      conforme: r.filter((x) => x.conforme).length,
      nao_conforme: r.filter((x) => x.encontrado && !x.conforme).length,
      nao_encontrado: r.filter((x) => !x.encontrado).length,
    };
  }
  const r = rows as Array<{ ok?: boolean }>;
  return {
    ok: r.filter((x) => x.ok).length,
    falha: r.filter((x) => !x.ok).length,
  };
}

function j(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
