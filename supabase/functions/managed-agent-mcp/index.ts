// =============================================================================
// managed-agent-mcp — Servidor MCP (Model Context Protocol) que expõe as 4
// tools do Cockpit pros Managed Agents da Anthropic.
//
// Caio 2026-06-10. Arquitetura:
//   Managed Agent (Anthropic) → POST JSON-RPC aqui → traduz → POST interno
//   pra managed-agent-tools → resposta volta como MCP result.
//
// Protocolo MCP (Streamable HTTP, JSON-RPC 2.0):
//   - initialize        → handshake
//   - tools/list        → lista as 4 tools com schema
//   - tools/call        → executa uma tool (delegando pra managed-agent-tools)
//   - ping              → keepalive (opcional)
//
// Auth: campo `authorization_token` do mcp_servers vira `Authorization: Bearer X`.
// Edge aceita esse header OU `X-Tool-Secret` (compat com curl tests).
//
// Agent identification: como o Console NÃO permite custom headers (só
// authorization_token), distinguimos os 2 agents pelo path final da URL:
//   .../managed-agent-mcp/triagem       → agent_01UDEQ5BDEUAr8Qw49mPnnHJ
//   .../managed-agent-mcp/aprendizado   → agent_01XjV7YMNujG2tkQw5WTfTYL
//
// INV-009: verify_jwt=false (auth próprio via Bearer/X-Tool-Secret).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const env = Deno.env.toObject();
const MCP_PROTOCOL_VERSION_DEFAULT = "2025-03-26"; // Streamable HTTP
const MCP_PROTOCOL_VERSIONS_SUPPORTED = ["2025-03-26", "2024-11-05"];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-tool-secret, x-agent-id, mcp-session-id, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

const AGENT_WHITELIST: Record<string, string> = {
  "agent_01UDEQ5BDEUAr8Qw49mPnnHJ": "triagem-noturna",
  "agent_01XjV7YMNujG2tkQw5WTfTYL": "aprendizado-continuo",
};

// Mapa path → agent_id. Como o Console Managed Agents só suporta
// `authorization_token` (sem custom headers), distinguimos os 2 agents pelo
// último segmento da URL configurada em cada um.
const PATH_TO_AGENT_ID: Record<string, string> = {
  "triagem": "agent_01UDEQ5BDEUAr8Qw49mPnnHJ",
  "aprendizado": "agent_01XjV7YMNujG2tkQw5WTfTYL",
};

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// =============================================================================
// TOOL DEFINITIONS (JSON Schema dos inputs — Managed Agent usa pra validar)
// =============================================================================

const TOOLS = [
  {
    name: "query_cockpit",
    description:
      "Executa uma query SELECT/WITH (somente leitura) no banco Postgres do Cockpit Sal Express. Retorna até 500 linhas. Timeout 10s. NÃO use INSERT/UPDATE/DELETE — rejeitado.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL SELECT/WITH válido." },
        razao: { type: "string", description: "1 frase explicando o objetivo da query. Vai pra auditoria." },
      },
      required: ["sql", "razao"],
    },
  },
  {
    name: "insert_learning_log",
    description:
      "Grava um achado no caderno do agente (tabela learning_log). Use uma vez por incidente/padrão/ajuste. NÃO use pra cada query intermediária — só pra conclusões.",
    inputSchema: {
      type: "object",
      properties: {
        tipo: {
          type: "string",
          enum: [
            "incidente_detectado", "incidente_resolvido",
            "padrao_identificado", "ajuste_sugerido",
            "metrica_snapshot", "impacto_medido",
          ],
        },
        severidade: { type: "string", enum: ["info", "warning", "critical"] },
        titulo: { type: "string", maxLength: 100 },
        resumo: { type: "string", maxLength: 500 },
        detalhes: { type: "object", description: "JSON livre: hipotese, sql_rodada, cards_envolvidos, evidencias." },
        card_ids: { type: "array", items: { type: "string", format: "uuid" } },
        agente_alvo: { type: "string", description: "Qual agente Cockpit é alvo do ajuste (ex: agente-sugere-ocs-padrao)." },
        prompt_alvo: { type: "string", description: "Arquivo prompts/*.md alvo." },
        diff_proposto: { type: "string", description: "Patch unified diff (opcional, se tipo=ajuste_sugerido)." },
        metrica_snapshot: { type: "object", description: "Snapshot de métricas (pra tipo=metrica_snapshot ou impacto_medido)." },
        parent_id: { type: "string", format: "uuid", description: "ID do learning_log pai (encadeamento padrão→sugestão→aprovação→impacto)." },
      },
      required: ["tipo", "titulo", "resumo"],
    },
  },
  {
    name: "send_digest_email",
    description:
      "Envia o digest markdown final pro email do Caio (caio@salexpress.com.br). Chame UMA vez no fim da execução. Use pro digest matinal (Triagem) ou digest dominical (Aprendizado).",
    inputSchema: {
      type: "object",
      properties: {
        assunto: { type: "string", description: "Subject curto, descritivo." },
        corpo_markdown: { type: "string", description: "Conteúdo em markdown, até 50k chars." },
      },
      required: ["assunto", "corpo_markdown"],
    },
  },
  {
    name: "propose_prompt_diff",
    description:
      "Grava um ajuste de prompt sugerido no learning_log com status='aberto'. Use quando, no modo Weekly Digest do Aprendizado, você quer propor mudança específica em prompts/*.md baseada em padrões fortes detectados.",
    inputSchema: {
      type: "object",
      properties: {
        arquivo_alvo: {
          type: "string",
          description: "Caminho prompts/<nome>.md (sem subpastas, sem .. )",
        },
        diff_unified: {
          type: "string",
          description: "Patch unified diff aplicável com `git apply`.",
        },
        justificativa: {
          type: "string",
          description: "1-3 frases ligando o diff ao padrão observado.",
        },
        parent_id: { type: "string", format: "uuid", description: "ID do padrao_identificado que originou (encadeamento)." },
        card_ids: { type: "array", items: { type: "string", format: "uuid" } },
      },
      required: ["arquivo_alvo", "diff_unified", "justificativa"],
    },
  },
];

// =============================================================================
// HANDLER MCP
// =============================================================================

serve(async (req) => {
  // CORS preflight — Console (browser) faz antes de POST cross-origin.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method === "GET") {
    // Alguns clientes MCP fazem GET no startup pra checar disponibilidade.
    return new Response(
      JSON.stringify({ status: "ok", protocol: "mcp", version: MCP_PROTOCOL_VERSION_DEFAULT }),
      { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const expectedSecret = env["MANAGED_AGENT_TOOLS_SECRET"];
  if (!expectedSecret) {
    return json({ error: "MANAGED_AGENT_TOOLS_SECRET ausente" }, 500);
  }

  // Identifica agent via PATH (sempre validado — sem agent_id válido, rejeita).
  // Console NÃO injeta vault auth durante discovery (initialize/tools/list);
  // só na session real. Por isso a auth abaixo é condicional ao method.
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter((p) => p.length > 0);
  const pathSuffix = pathParts[pathParts.length - 1] ?? "";
  const agentIdFromPath = PATH_TO_AGENT_ID[pathSuffix];
  const agentIdFromHeader = req.headers.get("x-agent-id");
  const agentId = agentIdFromPath ?? agentIdFromHeader ?? "";
  if (!AGENT_WHITELIST[agentId]) {
    return json({
      error: `agent não identificado. Configure URL com path /triagem ou /aprendizado. Recebido path='${pathSuffix}'.`,
    }, 403);
  }

  let rpc: JsonRpcRequest;
  try {
    rpc = await req.json() as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "Parse error: body precisa ser JSON-RPC válido");
  }

  if (rpc.jsonrpc !== "2.0" || !rpc.method) {
    return jsonRpcError(rpc.id ?? null, -32600, "Invalid Request: precisa de jsonrpc=2.0 e method");
  }

  const id = rpc.id ?? null;

  // Auth condicional por method:
  //   - initialize / tools/list / ping / notifications/* → sem auth (só metadata)
  //   - tools/call e demais → Bearer/X-Tool-Secret obrigatório
  // Path já validou agent_id, então sem auth ainda é caller na whitelist.
  const PUBLIC_METHODS = new Set([
    "initialize",
    "tools/list",
    "ping",
    "notifications/initialized",
    "notifications/cancelled",
  ]);
  if (!PUBLIC_METHODS.has(rpc.method)) {
    const authHeader = req.headers.get("authorization") ?? "";
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const bearerSecret = bearerMatch ? bearerMatch[1].trim() : null;
    const xToolSecret = req.headers.get("x-tool-secret");
    const providedSecret = bearerSecret ?? xToolSecret;
    if (providedSecret !== expectedSecret) {
      return jsonRpcError(id, -32001, "Auth obrigatório pra tools/call. Configure Credential Vault com Bearer token.");
    }
  }

  try {
    switch (rpc.method) {
      case "initialize": {
        // Negocia versão do protocolo: ecoa a do cliente se suportada,
        // senão usa a default (mais nova).
        const clientVersion = (rpc.params?.["protocolVersion"] as string | undefined) ?? "";
        const negotiated = MCP_PROTOCOL_VERSIONS_SUPPORTED.includes(clientVersion)
          ? clientVersion
          : MCP_PROTOCOL_VERSION_DEFAULT;
        // Streamable HTTP: gera Mcp-Session-Id e retorna no header.
        const sessionId = crypto.randomUUID();
        return jsonRpcOk(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "cockpit-managed-agent-tools", version: "1.0.0" },
        }, { "Mcp-Session-Id": sessionId });
      }

      case "notifications/initialized":
        // Notification: client confirma init. Não responde.
        return new Response(null, { status: 204, headers: CORS_HEADERS });

      case "ping":
        return jsonRpcOk(id, {});

      case "tools/list":
        return jsonRpcOk(id, { tools: TOOLS });

      case "tools/call": {
        const params = rpc.params ?? {};
        const toolName = params["name"] as string | undefined;
        const args = (params["arguments"] as Record<string, unknown> | undefined) ?? {};

        if (!toolName) {
          return jsonRpcError(id, -32602, "Invalid params: 'name' obrigatório em tools/call");
        }

        // Delega pra managed-agent-tools (HTTP interno)
        const toolsUrl = `${env["SUPABASE_URL"]}/functions/v1/managed-agent-tools`;
        const proxyRes = await fetch(toolsUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Tool-Secret": expectedSecret,
            "Authorization": `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
            "apikey": env["SUPABASE_SERVICE_ROLE_KEY"] ?? "",
          },
          body: JSON.stringify({
            agent_id: agentId,
            tool: toolName,
            params: args,
            managed_session_id: req.headers.get("x-mcp-session-id") ?? null,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        const proxyBody = await proxyRes.text();
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(proxyBody); } catch { /* ignore */ }

        const isError = !proxyRes.ok || parsed["ok"] === false;
        const textResult = isError
          ? `❌ Erro na tool ${toolName}: ${parsed["error"] ?? proxyBody.slice(0, 500)}`
          : JSON.stringify(parsed, null, 2);

        return jsonRpcOk(id, {
          content: [{ type: "text", text: textResult }],
          isError,
        });
      }

      default:
        return jsonRpcError(id, -32601, `Method not found: ${rpc.method}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[managed-agent-mcp] erro processando ${rpc.method}:`, msg);
    return jsonRpcError(id, -32603, `Internal error: ${msg.slice(0, 300)}`);
  }
});

// =============================================================================
// HELPERS
// =============================================================================

function jsonRpcOk(
  id: string | number | null,
  result: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): Response {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message, data } };
  return new Response(JSON.stringify(body), {
    status: 200,  // JSON-RPC errors usam HTTP 200 com error no body
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
