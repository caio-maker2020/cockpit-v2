// =============================================================================
// redator — gera sugestão de resposta a cliente, salva como todo no card.
//
// Disparado por:
//   1. Vinculador em background (logo após anexar mensagem nova ao card)
//   2. UI Lovable (botão "Regenerar") via POST direto
//
// Input: { card_id: string, force?: boolean }
// Output: { ok, todo_id, texto_preview, confianca }
//
// Comportamento:
// - Lê histórico de mensagens do card (últimos 10), classificação atual,
//   ação aprovada (se houver), dados do cliente (nome, empresa).
// - Chama Sonnet 4.6 com REDATOR_SYSTEM_PROMPT.
// - Cria/atualiza um todo do tipo `responder_cliente` no card. Se já existe
//   um pendente, atualiza (a menos que force=false e já foi enviado).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";
import {
  REDATOR_MODEL,
  REDATOR_VERSION,
} from "../_shared/prompts/redator.ts";
import { loadVozTemplate } from "../_shared/voz-template-loader.ts";

interface RedatorOutput {
  texto: string;
  assunto_sugerido: string | null;
  rationale: string;
  confianca: "alta" | "media" | "baixa";
}

interface RedatorRequest {
  card_id?: string;
  force?: boolean;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

serve(async (req) => {
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
    const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });

    const body = await req.json().catch(() => null) as RedatorRequest | null;
    if (!body || !body.card_id) {
      return jsonResponse(400, { error: "card_id obrigatório no body" });
    }

    const { card_id, force = false } = body;

    // 1. Pega card + dados de contexto
    const { data: card, error: cardErr } = await supabase
      .from("cards")
      .select("id, nf, ctrc, canal_origem, remetente_inicial, empresa_cliente, nome_cliente, tipo, risco, state, agent_state, cod_ultima_ocorrencia, assigned_operator_id")
      .eq("id", card_id)
      .single();

    if (cardErr || !card) {
      return jsonResponse(404, { error: `Card ${card_id} não encontrado: ${cardErr?.message}` });
    }

    // 2. Skip se já existe um todo responder_cliente pendente E não é force
    if (!force) {
      const { data: existing } = await supabase
        .from("todos")
        .select("id, status, proposta_payload")
        .eq("card_id", card_id)
        .eq("status", "pendente")
        .filter("proposta_payload->>tool", "eq", "responder_cliente")
        .limit(1);

      if (existing && existing.length > 0) {
        return jsonResponse(200, {
          ok: true,
          skipped: true,
          motivo: "Já existe sugestão pendente — use force=true pra regenerar",
          todo_id: existing[0]!.id,
        });
      }
    }

    // 3. Histórico de mensagens (até 10 últimas)
    const { data: messages } = await supabase
      .from("messages_inbox")
      .select("recebido_em, canal, remetente, conteudo")
      .eq("card_id", card_id)
      .order("recebido_em", { ascending: false })
      .limit(10);

    const historicoTxt = (messages ?? [])
      .reverse()
      .map((m) => `[${m.recebido_em} · ${m.canal} · ${m.remetente}]\n${String(m.conteudo).slice(0, 800)}`)
      .join("\n\n---\n\n");

    if (!historicoTxt) {
      return jsonResponse(400, { error: "Card sem mensagens — nada pra responder" });
    }

    // 4. Última ação tomada/proposta (último todo do card)
    const { data: ultimoTodo } = await supabase
      .from("todos")
      .select("descricao, status, proposta_payload, auto_approval_rule, approved_at")
      .eq("card_id", card_id)
      .order("created_at", { ascending: false })
      .limit(1);

    const ultimoTodoTxt = ultimoTodo && ultimoTodo[0]
      ? `Última ação no card: ${ultimoTodo[0]!.descricao} (status=${ultimoTodo[0]!.status}${ultimoTodo[0]!.auto_approval_rule ? ", auto-aprovado" : ""})`
      : "Sem ação anterior no card";

    // 5. Monta contexto pro Sonnet
    const userPrompt = [
      `Canal: ${card.canal_origem}`,
      `NF: ${card.nf ?? "?"}`,
      `Cliente: ${card.empresa_cliente ?? "?"}${card.nome_cliente ? ` (${card.nome_cliente})` : ""}`,
      `Remetente da mensagem original: ${card.remetente_inicial ?? "?"}`,
      `Tipo do caso: ${card.tipo ?? "?"}`,
      `State atual: ${card.state}`,
      `Última ocorrência SSW: ${card.cod_ultima_ocorrencia ?? "n/a"}`,
      ultimoTodoTxt,
      "",
      "Histórico de mensagens (mais antiga primeiro):",
      historicoTxt,
      "",
      "Gere a resposta da Larissa pra ÚLTIMA mensagem do cliente acima.",
    ].join("\n");

    // 6. Carrega voz do operador atribuído ao card (versionada em voz_templates).
    // Fallback automático pra prompt genérico se não encontrar.
    // Caio 2026-05-14: substitui REDATOR_SYSTEM_PROMPT hardcoded "Larissa".
    const voz = await loadVozTemplate(
      supabase,
      (card as Record<string, unknown>)["assigned_operator_id"] as string | null | undefined,
    );

    // 7. Chama Anthropic
    const sugestao = await anthropic.completeJson<RedatorOutput>({
      model: REDATOR_MODEL,
      system: voz.prompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 600,
      temperature: 0.4,
    });

    // 8. Telemetria
    await supabase.from("agent_runs").insert({
      agent_name: "redator",
      step_name: `version=${REDATOR_VERSION} voz=${voz.fonte}:v${voz.versao}`,
      input: {
        card_id,
        canal: card.canal_origem,
        mensagens_count: messages?.length ?? 0,
        voz_fonte: voz.fonte,
        voz_versao: voz.versao,
      },
      output: sugestao,
      model: REDATOR_MODEL,
      status: "success",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });

    // 8. Cria (ou atualiza) o todo de resposta sugerida
    const proposta_payload = {
      tool: "responder_cliente",
      args: {
        canal: card.canal_origem,
        destinatario: card.remetente_inicial,
        subject: sugestao.assunto_sugerido,
      },
      texto_sugerido: sugestao.texto,
      rationale: sugestao.rationale,
      confianca: sugestao.confianca,
      modelo_usado: REDATOR_MODEL,
      versao_prompt: REDATOR_VERSION,
      gerado_em: new Date().toISOString(),
    };

    let todo_id: string;

    // Se force=true, atualiza o pendente existente em vez de criar novo
    if (force) {
      const { data: existing } = await supabase
        .from("todos")
        .select("id")
        .eq("card_id", card_id)
        .eq("status", "pendente")
        .filter("proposta_payload->>tool", "eq", "responder_cliente")
        .limit(1);

      if (existing && existing.length > 0) {
        todo_id = existing[0]!.id as string;
        await supabase
          .from("todos")
          .update({ proposta_payload })
          .eq("id", todo_id);
      } else {
        todo_id = await createNewTodo(supabase, card_id, proposta_payload);
      }
    } else {
      todo_id = await createNewTodo(supabase, card_id, proposta_payload);
    }

    // 9. card_event de auditoria
    await supabase.from("card_events").insert({
      card_id,
      event_type: "RespostaSugerida",
      actor_type: "agent",
      actor_id: "redator",
      payload: {
        todo_id,
        canal: card.canal_origem,
        confianca: sugestao.confianca,
        texto_preview: sugestao.texto.slice(0, 200),
      },
    });

    return jsonResponse(200, {
      ok: true,
      todo_id,
      canal: card.canal_origem,
      confianca: sugestao.confianca,
      texto_preview: sugestao.texto.slice(0, 200),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("redator fatal:", msg);
    return jsonResponse(500, { error: msg });
  }
});

// =============================================================================

type SupabaseClient = ReturnType<typeof createClient>;

async function createNewTodo(
  supabase: SupabaseClient,
  cardId: string,
  proposta_payload: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await supabase
    .from("todos")
    .insert({
      card_id: cardId,
      action_id: crypto.randomUUID(),
      descricao: "Responder cliente",
      status: "pendente",
      proposta_payload,
    })
    .select("id")
    .single();

  if (error) throw new Error(`INSERT todos: ${error.message}`);
  return data.id as string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
