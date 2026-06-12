// =============================================================================
// managed-agent-tools — endpoint que os Managed Agents externos da Anthropic
// chamam pra executar tools no Cockpit Sal Express.
//
// Caio 2026-06-10. Suporta 4 tools:
//   - query_cockpit(sql, razao)        → SELECT readonly + auditoria
//   - insert_learning_log(...)         → INSERT em learning_log
//   - send_digest_email(assunto, corpo)→ envia via Postmark pro Caio
//   - propose_prompt_diff(...)         → grava ajuste sugerido em learning_log
//
// Auth: header X-Tool-Secret deve bater com MANAGED_AGENT_TOOLS_SECRET.
// Body obrigatório: { agent_id, tool, params, managed_session_id?, managed_message_id? }
// agent_id precisa estar na whitelist (2 IDs hard-coded).
//
// Cada request grava em managed_agent_tool_calls sempre — sucesso, erro,
// auth-rejected, validation-rejected.
//
// INV-009: verify_jwt=false (chamada externa via secret próprio).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const env = Deno.env.toObject();

// Whitelist hard-coded dos 2 agents criados no Console (2026-06-10)
const AGENT_WHITELIST: Record<string, string> = {
  "agent_01UDEQ5BDEUAr8Qw49mPnnHJ": "triagem-noturna",
  "agent_01XjV7YMNujG2tkQw5WTfTYL": "aprendizado-continuo",
};

const VALID_TOOLS = ["query_cockpit", "insert_learning_log", "send_digest_email", "propose_prompt_diff"] as const;
type ToolName = typeof VALID_TOOLS[number];

const ALERT_FROM_EMAIL = "noreply@salexpress.com.br";
const ALERT_TO_EMAIL = "caio@salexpress.com.br";

interface RequestBody {
  agent_id: string;
  tool: ToolName;
  params: Record<string, unknown>;
  managed_session_id?: string;
  managed_message_id?: string;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const expectedSecret = env["MANAGED_AGENT_TOOLS_SECRET"];
  if (!expectedSecret) {
    return json({ error: "MANAGED_AGENT_TOOLS_SECRET ausente no servidor" }, 500);
  }

  const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const startedAtMs = Date.now();
  let body: RequestBody;
  try {
    body = await req.json() as RequestBody;
  } catch {
    return json({ error: "Body precisa ser JSON válido" }, 400);
  }

  // Auth check
  const providedSecret = req.headers.get("x-tool-secret");
  if (providedSecret !== expectedSecret) {
    await audit(supabase, body, "rejected_auth", null, "X-Tool-Secret inválido ou ausente", Date.now() - startedAtMs);
    return json({ error: "Auth inválido" }, 401);
  }

  // Validações estruturais
  if (!body.agent_id || !body.tool || !body.params) {
    await audit(supabase, body, "rejected_validation", null, "Faltam campos: agent_id, tool, params", Date.now() - startedAtMs);
    return json({ error: "agent_id, tool e params obrigatórios" }, 400);
  }

  const agentNome = AGENT_WHITELIST[body.agent_id];
  if (!agentNome) {
    await audit(supabase, body, "rejected_auth", null, `agent_id ${body.agent_id} fora da whitelist`, Date.now() - startedAtMs);
    return json({ error: `agent_id ${body.agent_id} não autorizado` }, 403);
  }

  if (!VALID_TOOLS.includes(body.tool)) {
    await audit(supabase, body, "rejected_validation", null, `tool inválida: ${body.tool}`, Date.now() - startedAtMs);
    return json({ error: `Tool inválida. Use: ${VALID_TOOLS.join(", ")}` }, 400);
  }

  // Dispatch
  try {
    let result: Record<string, unknown>;
    switch (body.tool) {
      case "query_cockpit":
        result = await toolQueryCockpit(supabase, body.params);
        break;
      case "insert_learning_log":
        result = await toolInsertLearningLog(supabase, agentNome, body);
        break;
      case "send_digest_email":
        result = await toolSendDigestEmail(body.params);
        break;
      case "propose_prompt_diff":
        result = await toolProposePromptDiff(supabase, agentNome, body);
        break;
    }

    await audit(supabase, body, "success", result, null, Date.now() - startedAtMs);
    return json({ ok: true, ...result }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit(supabase, body, "error", null, msg, Date.now() - startedAtMs);
    return json({ ok: false, error: msg }, 500);
  }
});

// ============================================================================
// TOOLS
// ============================================================================

// ---------------------------------------------------------------------------
// query_cockpit — executa SELECT readonly
// ---------------------------------------------------------------------------
async function toolQueryCockpit(
  supabase: SupabaseClient,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sql = params["sql"] as string | undefined;
  const razao = params["razao"] as string | undefined;

  if (!sql || typeof sql !== "string") throw new Error("params.sql é obrigatório (string)");
  if (!razao || typeof razao !== "string") throw new Error("params.razao é obrigatório (string)");
  if (sql.length > 8000) throw new Error("SQL muito grande (>8000 chars)");

  // Defesa em profundidade: valida via função SQL
  const { data: valido, error: valErr } = await supabase.rpc("validar_sql_readonly", { p_sql: sql });
  if (valErr) throw new Error(`Falha validando SQL: ${valErr.message}`);
  if (valido !== true) {
    throw new Error("SQL rejeitado: precisa começar com SELECT/WITH, sem comandos de escrita ou funções perigosas.");
  }

  // Roda via RPC genérica de SELECT — exposta numa próxima migration.
  // Por enquanto, usa exec via pgrest endpoint não funciona pra SQL livre,
  // então delegamos ao Postgres via função `run_managed_agent_query`.
  const { data, error } = await supabase.rpc("run_managed_agent_query", { p_sql: sql });
  if (error) throw new Error(`Erro executando SQL: ${error.message}`);

  return {
    razao,
    sql_executado: sql,
    linhas: data,
    row_count: Array.isArray(data) ? data.length : 0,
  };
}

// ---------------------------------------------------------------------------
// insert_learning_log
// ---------------------------------------------------------------------------
async function toolInsertLearningLog(
  supabase: SupabaseClient,
  agentNome: string,
  body: RequestBody,
): Promise<Record<string, unknown>> {
  const p = body.params;
  const tipo = p["tipo"] as string | undefined;
  const severidade = (p["severidade"] as string | undefined) ?? null;
  const titulo = p["titulo"] as string | undefined;
  const resumo = p["resumo"] as string | undefined;
  const detalhes = (p["detalhes"] as Record<string, unknown> | undefined) ?? {};
  const card_ids = p["card_ids"] as string[] | undefined;
  const agente_alvo = p["agente_alvo"] as string | undefined;
  const prompt_alvo = p["prompt_alvo"] as string | undefined;
  const diff_proposto = p["diff_proposto"] as string | undefined;
  const metrica_snapshot = p["metrica_snapshot"] as Record<string, unknown> | undefined;
  const parent_id = p["parent_id"] as string | undefined;
  const tokens_in = p["tokens_in"] as number | undefined;
  const tokens_out = p["tokens_out"] as number | undefined;

  if (!tipo) throw new Error("params.tipo obrigatório");
  if (!titulo) throw new Error("params.titulo obrigatório");
  if (!resumo) throw new Error("params.resumo obrigatório");
  if (titulo.length > 100) throw new Error("titulo > 100 chars");
  if (resumo.length > 500) throw new Error("resumo > 500 chars");

  const row = {
    agente: agentNome,
    tipo,
    severidade,
    titulo,
    resumo,
    detalhes,
    card_ids: card_ids ?? null,
    agente_alvo: agente_alvo ?? null,
    prompt_alvo: prompt_alvo ?? null,
    diff_proposto: diff_proposto ?? null,
    metrica_snapshot: metrica_snapshot ?? null,
    parent_id: parent_id ?? null,
    managed_agent_session_id: body.managed_session_id ?? null,
    managed_agent_message_id: body.managed_message_id ?? null,
    tokens_in: tokens_in ?? null,
    tokens_out: tokens_out ?? null,
  };

  const { data, error } = await supabase
    .from("learning_log")
    .insert(row)
    .select("id, created_at")
    .single();

  if (error) throw new Error(`Falha INSERT learning_log: ${error.message}`);

  return { learning_log_id: data!.id, created_at: data!.created_at };
}

// ---------------------------------------------------------------------------
// send_digest_email — envia via Postmark
// ---------------------------------------------------------------------------
async function toolSendDigestEmail(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const postmarkToken = env["POSTMARK_SERVER_TOKEN"];
  if (!postmarkToken) throw new Error("POSTMARK_SERVER_TOKEN ausente");

  const assunto = params["assunto"] as string | undefined;
  const corpo_markdown = params["corpo_markdown"] as string | undefined;
  if (!assunto) throw new Error("params.assunto obrigatório");
  if (!corpo_markdown) throw new Error("params.corpo_markdown obrigatório");
  if (corpo_markdown.length > 50_000) throw new Error("corpo_markdown muito grande (>50k)");

  // Renderiza markdown como HTML simples (não vamos importar lib pesada — só wraps em <pre>)
  const htmlBody = `<pre style="font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; white-space: pre-wrap;">${escapeHtml(corpo_markdown)}</pre>`;

  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": postmarkToken,
    },
    body: JSON.stringify({
      From: `Cockpit Agents <${ALERT_FROM_EMAIL}>`,
      To: ALERT_TO_EMAIL,
      ReplyTo: ALERT_TO_EMAIL,
      Subject: assunto,
      TextBody: corpo_markdown,
      HtmlBody: htmlBody,
      MessageStream: "outbound",
      Tag: "managed-agent-digest",
      Headers: [
        { Name: "Auto-Submitted", Value: "auto-generated" },
        { Name: "X-Auto-Response-Suppress", Value: "All" },
        { Name: "Precedence", Value: "auto_reply" },
      ],
    }),
  });

  const responseBody = await res.text();
  if (!res.ok) throw new Error(`Postmark ${res.status}: ${responseBody.slice(0, 300)}`);

  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(responseBody); } catch { /* ignore */ }

  return { postmark_message_id: parsed["MessageID"], to: ALERT_TO_EMAIL };
}

// ---------------------------------------------------------------------------
// propose_prompt_diff — grava em learning_log como ajuste_sugerido
// ---------------------------------------------------------------------------
async function toolProposePromptDiff(
  supabase: SupabaseClient,
  agentNome: string,
  body: RequestBody,
): Promise<Record<string, unknown>> {
  const p = body.params;
  const arquivo_alvo = p["arquivo_alvo"] as string | undefined;
  const diff_unified = p["diff_unified"] as string | undefined;
  const justificativa = p["justificativa"] as string | undefined;
  const parent_id = p["parent_id"] as string | undefined;
  const card_ids = p["card_ids"] as string[] | undefined;

  if (!arquivo_alvo) throw new Error("params.arquivo_alvo obrigatório");
  if (!diff_unified) throw new Error("params.diff_unified obrigatório");
  if (!justificativa) throw new Error("params.justificativa obrigatório");

  // Validações de segurança no arquivo_alvo
  if (!arquivo_alvo.startsWith("prompts/") || !arquivo_alvo.endsWith(".md")) {
    throw new Error("arquivo_alvo deve ser caminho prompts/*.md");
  }
  if (arquivo_alvo.includes("..") || arquivo_alvo.includes("/")) {
    // Permite só prompts/<nome>.md, sem subpastas
    const partes = arquivo_alvo.split("/");
    if (partes.length !== 2) throw new Error("arquivo_alvo não pode ter subpastas");
  }

  if (diff_unified.length > 30_000) throw new Error("diff_unified muito grande (>30k)");

  const row = {
    agente: agentNome,
    tipo: "ajuste_sugerido",
    severidade: "info",
    titulo: `Ajuste sugerido em ${arquivo_alvo}`,
    resumo: justificativa.slice(0, 500),
    detalhes: { arquivo_alvo, justificativa },
    card_ids: card_ids ?? null,
    prompt_alvo: arquivo_alvo,
    diff_proposto: diff_unified,
    parent_id: parent_id ?? null,
    managed_agent_session_id: body.managed_session_id ?? null,
    managed_agent_message_id: body.managed_message_id ?? null,
  };

  const { data, error } = await supabase
    .from("learning_log")
    .insert(row)
    .select("id, created_at")
    .single();

  if (error) throw new Error(`Falha INSERT learning_log: ${error.message}`);

  return { learning_log_id: data!.id, created_at: data!.created_at };
}

// ============================================================================
// HELPERS
// ============================================================================

type SupabaseClient = ReturnType<typeof createClient>;

async function audit(
  supabase: SupabaseClient,
  body: Partial<RequestBody>,
  status: "success" | "error" | "rejected_validation" | "rejected_auth",
  response: Record<string, unknown> | null,
  errorMessage: string | null,
  durationMs: number,
): Promise<void> {
  try {
    const agentNome = body.agent_id ? AGENT_WHITELIST[body.agent_id] ?? "desconhecido" : "desconhecido";
    await supabase.from("managed_agent_tool_calls").insert({
      agent_id: body.agent_id ?? "desconhecido",
      agent_nome: agentNome,
      tool_name: body.tool ?? "desconhecido",
      managed_session_id: body.managed_session_id ?? null,
      managed_message_id: body.managed_message_id ?? null,
      request_payload: body.params ?? {},
      response_payload: response,
      status,
      error_message: errorMessage,
      duration_ms: durationMs,
    });
  } catch (logErr) {
    console.error("[managed-agent-tools] auditoria falhou:", logErr instanceof Error ? logErr.message : String(logErr));
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
