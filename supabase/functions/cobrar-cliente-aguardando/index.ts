// =============================================================================
// cobrar-cliente-aguardando — envia email curto de cobrança pro cliente que
// está em AGUARDANDO_CLIENTE há > 4 dias úteis sem responder.
//
// 2 modos:
//   - manual: operador clica botão na aba RESPOSTA. Sem contador.
//   - automatico: chamado pelo cron `processar-cobrancas-cliente-aguardando`
//     quando passa 4 dias úteis do último outbound. Máximo 2 disparos (4d + 8d).
//
// Texto padrão (Caio 2026-05-15):
//   "{nome_pessoa}, estamos aguardando um retorno para finalizarmos a tratativa.
//   Obrigado."
//
// Envio em REPLY do último cards_emails_outbound — mesmo thread, In-Reply-To
// do outbound anterior. Cliente vê como continuação natural da conversa.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { bloquearSeModoVisualizacao } from "../_shared/trava-visualizacao.ts";
import { sendGmailMessage } from "../_shared/gmail-sender.ts";
import { garantirPrefixoReply } from "../_shared/email-threading.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function withAngleBrackets(id: string | null | undefined): string | null {
  if (!id) return null;
  const t = id.trim();
  if (!t) return null;
  if (t.startsWith("<") && t.endsWith(">")) return t;
  return `<${t}>`;
}

interface InputBody {
  card_id?: string;
  modo?: "manual" | "automatico";
}

serve(async (req) => {
  // Trava modo visualização (mig 324): gestor só-leitura (João/Isadora) não
  // executa; service_role e preflight passam direto (sem Authorization → null).
  {
    const travaAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const bloqueio = await bloquearSeModoVisualizacao(req, travaAdmin, corsHeaders);
    if (bloqueio) return bloqueio;
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return jsonResp({ ok: false, error: "POST esperado" }, 405);

  const env = Deno.env.toObject();
  const supabaseSvc = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  let body: InputBody;
  try {
    body = await req.json();
  } catch {
    return jsonResp({ ok: false, error: "JSON inválido" }, 400);
  }
  if (!body.card_id) return jsonResp({ ok: false, error: "card_id obrigatório" }, 400);
  const modo: "manual" | "automatico" = body.modo === "automatico" ? "automatico" : "manual";

  // 1. Carrega card + operador
  const { data: card } = await supabaseSvc
    .from("cards")
    .select("id, nf, state, assigned_operator_id, empresa_cliente, nome_cliente, cobranca_cliente_emails_enviados, cliente_respondeu_em")
    .eq("id", body.card_id)
    .maybeSingle();
  if (!card) return jsonResp({ ok: false, error: "card não encontrado" }, 404);
  if (card.state !== "AGUARDANDO_CLIENTE") {
    return jsonResp({
      ok: false,
      error: `card não está em AGUARDANDO_CLIENTE (state=${card.state}). Cobrança só faz sentido aqui.`,
    }, 409);
  }
  if (card.cliente_respondeu_em) {
    return jsonResp({
      ok: false,
      error: "cliente já respondeu este card — não precisa cobrar.",
    }, 409);
  }

  // 2. Cap automático: máx 2 disparos automáticos. Manual não tem cap.
  if (modo === "automatico" && (card.cobranca_cliente_emails_enviados as number) >= 2) {
    return jsonResp({
      ok: false,
      error: "Card já recebeu 2 cobranças automáticas — pare. Operador pode disparar manual via aba RESPOSTA.",
    }, 409);
  }

  // 3. Último outbound desse card pra herdar thread + recipientes
  const { data: outbound } = await supabaseSvc
    .from("cards_emails_outbound")
    .select("gmail_message_id, gmail_thread_id, message_id_header, from_email, to_email, subject, sent_at")
    .eq("card_id", card.id)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!outbound) {
    return jsonResp({
      ok: false,
      error: "Card sem email outbound prévio — não há thread pra cobrar em cima.",
    }, 409);
  }
  if (!outbound.gmail_thread_id) {
    return jsonResp({ ok: false, error: "Outbound sem gmail_thread_id" }, 500);
  }
  const toEmail = outbound.to_email as string | null;
  if (!toEmail) {
    return jsonResp({ ok: false, error: "Outbound sem to_email" }, 500);
  }

  // 4. Resolve o primeiro nome da PESSOA destinatária via fonte única (mig 225):
  // só nome de pessoa, nunca empresa ("F E F DISTRIBUIDORA"→"F") nem rótulo
  // genérico (SAC, Central). Sem nome confiável → "Prezado(a)," (cobrança é
  // resposta 1:1 na thread). Não bloquear envio por causa do nome.
  const { data: primeiroNomeResolvido } = await supabaseSvc.rpc("resolver_primeiro_nome_email", {
    p_email: toEmail,
    p_empresa: (card.empresa_cliente as string | null) ?? "",
  });
  const primeiroNome = typeof primeiroNomeResolvido === "string" ? primeiroNomeResolvido.trim() : "";
  const saudacao = primeiroNome ? `${primeiroNome},` : "Prezado(a),";

  // 5. Texto fixo (Caio 2026-05-15)
  const textoCobranca =
    `${saudacao}\n\nEstamos aguardando um retorno para finalizarmos a tratativa.\n\nObrigado.`;

  // 6. Operador do card pra usar nas creds Gmail
  if (!card.assigned_operator_id) {
    return jsonResp({ ok: false, error: "card sem assigned_operator_id — não dá pra enviar" }, 500);
  }
  const { data: op } = await supabaseSvc
    .from("operadores")
    .select("id, nome, email_relacionamento")
    .eq("id", card.assigned_operator_id)
    .maybeSingle();
  if (!op) return jsonResp({ ok: false, error: "operador não encontrado" }, 500);

  // 7. Subject = Re: do original (se já tiver Re:, mantém)
  const subjOrig = (outbound.subject as string | null) ?? "Cobrança";
  const subject = garantirPrefixoReply(subjOrig);

  // 8. In-Reply-To do outbound anterior (mantém thread)
  const msgIdOrigem = withAngleBrackets(
    (outbound.message_id_header as string | null) ?? (outbound.gmail_message_id as string | null),
  );
  const extraHeaders: Record<string, string> = {};
  if (msgIdOrigem) {
    extraHeaders["In-Reply-To"] = msgIdOrigem;
    extraHeaders["References"] = msgIdOrigem;
  }

  // 9. Envia (gmail-sender resolve refresh_token)
  const sendResult = await sendGmailMessage({
    supabase: supabaseSvc,
    operadorId: op.id as string,
    destinatario: toEmail,
    cc: [],
    subject,
    texto: textoCobranca,
    fromName: op.nome as string | null,
    attachments: [],
    extraHeaders,
    threadId: outbound.gmail_thread_id as string,
  });
  if (!sendResult.ok) {
    return jsonResp({ ok: false, error: `gmail-send falhou: ${sendResult.error}` }, 500);
  }

  const gmailMessageId = sendResult.messageId;
  const threadId = sendResult.threadId;

  // 10. Registra outbound
  if (gmailMessageId && threadId) {
    await supabaseSvc.from("cards_emails_outbound").upsert(
      {
        card_id: card.id,
        operadora_id: op.id,
        gmail_message_id: gmailMessageId,
        gmail_thread_id: threadId,
        from_email: op.email_relacionamento ?? (outbound.from_email as string | null),
        to_email: toEmail,
        subject,
        corpo_renderizado: textoCobranca,
      },
      { onConflict: "gmail_message_id" },
    );
  }

  // 11. Update contador (só modo automatico). Manual NÃO incrementa — operador
  // pode disparar quantas quiser sem afetar agendamento automático.
  if (modo === "automatico") {
    await supabaseSvc
      .from("cards")
      .update({
        cobranca_cliente_emails_enviados: (card.cobranca_cliente_emails_enviados as number) + 1,
        cobranca_cliente_ultima_em: new Date().toISOString(),
      })
      .eq("id", card.id);
  }

  // 12. Audit
  await supabaseSvc.from("card_events").insert({
    card_id: card.id,
    event_type: "CobrancaClienteEmailEnviada",
    actor_type: modo === "manual" ? "operator" : "system",
    actor_id: modo === "manual" ? op.id : "cobrar-cliente-aguardando",
    payload: {
      modo,
      destinatario: toEmail,
      gmail_message_id: gmailMessageId,
      gmail_thread_id: threadId,
      contagem_auto_pos_disparo:
        modo === "automatico" ? (card.cobranca_cliente_emails_enviados as number) + 1 : null,
      observacao:
        modo === "automatico"
          ? "Cobrança autônoma — cliente sem retorno em 4 dias úteis do último outbound. Máximo 2 disparos."
          : "Cobrança manual disparada pela aba RESPOSTA do Cockpit.",
    },
  });

  return jsonResp({
    ok: true,
    modo,
    gmail_message_id: gmailMessageId,
    gmail_thread_id: threadId,
    destinatario: toEmail,
    saudacao,
    contagem_automatica_pos_disparo:
      modo === "automatico" ? (card.cobranca_cliente_emails_enviados as number) + 1 : null,
  });
});
