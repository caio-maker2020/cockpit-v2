// =============================================================================
// redator-email-saida — Gera sugestão de texto pra email OUTBOUND que vai
// junto com lançamento de oc específica (54, etc). Diferente do `redator`
// (que gera resposta pra email INBOUND do cliente), este gera o email QUE
// VAI SAIR baseado no contexto da oc + dados do card.
//
// Input:  { card_id: string, codigo_ssw_proposto: number, template_id?: string }
// Output: { texto: string, assunto: string, rationale: string }
//
// Uso pelo frontend: Larissa clica "Gerar com IA" no composer do modal de
// aprovação. Frontend chama essa função, preenche textarea com `texto`.
// Larissa pode editar e clicar "Confirmar e enviar". O texto editado vai
// pro executor via p_extras.texto_email_customizado.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";
import { loadVozTemplate } from "../_shared/voz-template-loader.ts";

const MODEL = "claude-sonnet-4-6";

// Contexto base por código de oc proposto. Caio vai me passar contextos
// mais detalhados depois — por enquanto cobre o que sabemos do processo.
const CONTEXTO_POR_OC: Record<string, string> = {
  "54": "Você está pedindo ao cliente uma decisão sobre uma carga em situação especial (extravio, problema de endereço, recusa, falta volume). O email deve: (1) avisar a situação de forma clara, (2) listar opções concretas que o cliente pode escolher, (3) pedir resposta. Tom profissional mas próximo, sem jargão.",
  "44": "Você está informando o cliente sobre o retorno da carga ao centro de devolução. Email curto e objetivo: confirma a devolução, número da NFD se houver, próximos passos. Tom transacional.",
  "55": "Você está confirmando ao cliente a autorização de seguir com entrega parcial / autorizar tentativa adicional. Email curto: confirma a ação, próximas etapas.",
  "21": "Você está confirmando ao cliente que reentrega foi solicitada. Email curto: dia previsto, mesmo endereço (ou novo se cliente passou).",
};

// Caio 2026-05-14: SYSTEM_PROMPT removido. Voz vem de voz_templates por
// operador (carregada via loadVozTemplate). Fallback genérico em
// REDATOR_SYSTEM_PROMPT_GENERICO (sem nome próprio).

interface InputBody {
  card_id?: string;
  codigo_ssw_proposto?: number | string;
  template_id?: string | null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });

    const body = await req.json().catch(() => null) as InputBody | null;
    if (!body?.card_id || !body.codigo_ssw_proposto) {
      return json({ error: "card_id e codigo_ssw_proposto obrigatórios" }, 400);
    }

    const codigo = String(body.codigo_ssw_proposto);

    // Carrega contexto do card
    const { data: card } = await supabase
      .from("cards")
      .select("nf, empresa_cliente, nome_cliente, cod_ultima_ocorrencia, agent_state, responsavel_relacionamento, assigned_operator_id")
      .eq("id", body.card_id)
      .maybeSingle();
    if (!card) return json({ error: "card não encontrado" }, 404);

    const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
    const empresaCliente = (card.empresa_cliente as string | null) ?? "Cliente";
    const nomeCliente = (card.nome_cliente as string | null) ?? null;
    const operadoraNome = (card.responsavel_relacionamento as string | null) ?? "a operadora";

    // Últimas mensagens do cliente (se houver) — dão contexto da conversa
    const { data: msgs } = await supabase
      .from("messages_inbox")
      .select("conteudo, recebido_em")
      .eq("card_id", body.card_id)
      .order("recebido_em", { ascending: false })
      .limit(3);
    const historico = (msgs ?? [])
      .reverse()
      .map((m) => String(m.conteudo).slice(0, 500))
      .join("\n---\n");

    const contextoOc = CONTEXTO_POR_OC[codigo] ??
      `Você está informando o cliente sobre o lançamento da ocorrência ${codigo} no sistema. Use tom apropriado.`;

    const userPrompt = [
      `Operadora: ${operadoraNome}`,
      `Cliente: ${empresaCliente}${nomeCliente ? ` (${nomeCliente})` : ""}`,
      `NF: ${card.nf ?? "?"}`,
      `Última ocorrência atual: ${card.cod_ultima_ocorrencia ?? "?"}`,
      `Cidade destino: ${(agentState["cidade_destino"] as string | null) ?? "?"}`,
      `Previsão original: ${(agentState["previsao_entrega"] as string | null) ?? "?"}`,
      `Descrição da última ocorrência: ${(agentState["instrucao_ultima_ocorrencia"] as string | null) ?? "?"}`,
      "",
      `Você está prestes a lançar oc=${codigo} no SSW e mandar um email pro cliente avisando.`,
      `Contexto desta oc: ${contextoOc}`,
      "",
      historico ? `Histórico recente de mensagens com esse cliente:\n${historico}` : "Sem histórico anterior de mensagens nesse caso.",
      "",
      "Gere o email outbound (assunto + texto completo).",
    ].join("\n");

    // Carrega voz do operador atribuído (versionada em voz_templates).
    // Caio 2026-05-14: substitui SYSTEM_PROMPT hardcoded "Larissa".
    const voz = await loadVozTemplate(
      supabase,
      (card as Record<string, unknown>)["assigned_operator_id"] as string | null | undefined,
    );

    const out = await anthropic.completeJson<{ texto: string; assunto: string; rationale: string }>({
      model: MODEL,
      system: voz.prompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 700,
      temperature: 0.5,
    });

    return json({
      ok: true,
      texto: out.texto,
      assunto: out.assunto,
      rationale: out.rationale,
      contexto_oc_usado: contextoOc,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("redator-email-saida fatal:", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
