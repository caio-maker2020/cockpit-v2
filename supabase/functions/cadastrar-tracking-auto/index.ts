// =============================================================================
// cadastrar-tracking-auto — Busca a senha do "Site de rastreamento" no SSW
// interno (opção 383) pra um CNPJ e faz upsert em `tracking_credentials`.
//
// Resolve o bug de NFs sem senha cadastrada: hoje gestor precisa entrar no SSW
// manualmente, copiar a senha e digitar na UI Lovable. Esta função automatiza
// — Larissa pede "cadastrar tracking 03662136000236" e o sistema busca + grava
// sozinho.
//
// Endpoint: POST { cnpj: "03662136000236" }
// Resposta: { ok: true, cnpj, nome_amigavel, senha, senha_obrigatoria, persisted }
//          ou { ok: false, error: "...", cnpj_nao_encontrado?: true }
//
// Persistência: tabela `tracking_credentials` (PK=documento, 14 dígitos).
// Idempotente — UPSERT atualiza senha + nome se já existir.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  obterSenhaTrackingPorCnpj,
  readSswInternalEnv,
} from "../_shared/ssw-internal-client.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "POST esperado" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, error: "SUPABASE env ausente" }, 500);
  }

  let body: { cnpj?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON body inválido" }, 400);
  }
  if (!body.cnpj) {
    return json({ ok: false, error: "campo cnpj obrigatório" }, 400);
  }

  const cnpj = String(body.cnpj).replace(/\D/g, "");
  if (cnpj.length !== 14) {
    return json({ ok: false, error: `CNPJ inválido: ${body.cnpj} (esperado 14 dígitos)` }, 400);
  }

  let sswEnv;
  try {
    sswEnv = readSswInternalEnv(Deno.env.toObject());
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }

  let resultado;
  try {
    resultado = await obterSenhaTrackingPorCnpj(sswEnv, cnpj);
  } catch (err) {
    return json({ ok: false, error: `SSW opção 383: ${String(err)}` }, 502);
  }

  if (resultado.senha == null && resultado.nome_amigavel == null) {
    return json({
      ok: false,
      error: "CNPJ não encontrado no cadastro SSW (opção 383)",
      cnpj_nao_encontrado: true,
      cnpj,
    }, 404);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve operador_responsavel_id:
  //  1. Preserva o existente se a linha já existir.
  //  2. Senão usa body.operador_id se fornecido.
  //  3. Senão fallback: operador único ativo (Larissa hoje).
  let operadorId: string | null = null;
  const { data: existente } = await supabase
    .from("tracking_credentials")
    .select("operador_responsavel_id")
    .eq("documento", cnpj)
    .maybeSingle();
  if (existente?.operador_responsavel_id) {
    operadorId = existente.operador_responsavel_id as string;
  } else if ((body as { operador_id?: string }).operador_id) {
    operadorId = (body as { operador_id?: string }).operador_id!;
  } else {
    const { data: defaultOp } = await supabase
      .from("operadores")
      .select("id")
      .eq("papel", "operador")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    operadorId = (defaultOp?.id as string) ?? null;
  }
  if (!operadorId) {
    return json({ ok: false, error: "operador_responsavel_id não pôde ser determinado" }, 500);
  }

  const { data: persisted, error: upErr } = await supabase
    .from("tracking_credentials")
    .upsert(
      {
        documento: cnpj,
        nome_amigavel: resultado.nome_amigavel,
        senha: resultado.senha,
        operador_responsavel_id: operadorId,
        notes: `Auto-cadastrado via opção 383 em ${new Date().toISOString()}. Senha obrigatória: ${resultado.senha_obrigatoria === null ? "?" : resultado.senha_obrigatoria ? "S" : "N"}`,
        ativo: true,
      },
      { onConflict: "documento" },
    )
    .select("documento, nome_amigavel, senha, ativo, operador_responsavel_id")
    .single();

  if (upErr) {
    return json({ ok: false, error: `Upsert tracking_credentials: ${upErr.message}` }, 500);
  }

  return json({
    ok: true,
    cnpj,
    nome_amigavel: resultado.nome_amigavel,
    senha: resultado.senha,
    senha_obrigatoria: resultado.senha_obrigatoria,
    persisted,
  }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
