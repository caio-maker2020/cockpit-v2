// =============================================================================
// responder-email-cliente — Larissa responde email do cliente direto pelo
// Cockpit. Envio via Gmail API com headers In-Reply-To/References pra manter
// thread no Gmail (cliente vê resposta na mesma conversa).
//
// Input: { card_id, texto, mensagem_origem_id? }
// Auth:  Bearer da operadora (auth.uid() → operadores → gmail_oauth_credentials)
//
// Fluxo:
//   1. Auth Larissa
//   2. Carrega card + última mensagem inbound (ou mensagem_origem_id se passado)
//   3. Carrega operador → Gmail credentials → access_token (refresh se preciso)
//   4. Compose RFC 2822: From=Larissa, To=remetente original (sem CC),
//      Subject="Re: ...", In-Reply-To=<msg-origem>, References=<cadeia>
//   5. POST gmail/users/me/messages/send
//   6. INSERT card_event "RespostaManualEnviadaPeloCockpit"
//   7. Retorna { ok, gmail_message_id, thread_id }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

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

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ ok: false, error: "Authorization Bearer obrigatório" }, 401);
    }

    const supabaseUser = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_ANON_KEY"]!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userRes } = await supabaseUser.auth.getUser();
    const user = userRes?.user;
    if (!user) return json({ ok: false, error: "User não autenticado" }, 401);

    const supabaseSvc = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const body = await req.json().catch(() => ({}));
    const cardId: string | undefined = body.card_id;
    const texto: string | undefined = body.texto;
    const mensagemOrigemId: string | undefined = body.mensagem_origem_id;
    // cc opcional: array de emails extras pra copiar. Operadora seleciona via
    // multi-select dos contatos do cliente. Padrão idêntico ao composer oc=54:
    // 1 único envio Gmail com TO + Cc (nunca múltiplos emails separados).
    const ccBruto: string[] = Array.isArray(body.cc)
      ? (body.cc as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    // Caio 2026-05-06: anexos opcionais (UUIDs em email_anexos)
    const anexosIds: string[] = Array.isArray(body.anexos_ids)
      ? (body.anexos_ids as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];

    if (!cardId || !texto?.trim()) {
      return json({ ok: false, error: "card_id e texto obrigatórios" }, 400);
    }

    // 1. Operadora + Gmail credentials
    const { data: op } = await supabaseSvc
      .from("operadores")
      .select("id, nome, gmail_oauth_credentials")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!op?.gmail_oauth_credentials) {
      return json({
        ok: false,
        error: "Operadora sem Gmail conectado. Conecte em Configurações > Email do Cockpit.",
      }, 400);
    }
    const creds = op.gmail_oauth_credentials as {
      refresh_token: string;
      email: string;
      access_token_cache?: string;
      access_token_expira_em?: string;
    };

    // 2. Carrega card + mensagem origem
    const { data: card } = await supabaseSvc
      .from("cards")
      .select("id, nf, empresa_cliente")
      .eq("id", cardId)
      .maybeSingle();
    if (!card) return json({ ok: false, error: "card não encontrado" }, 404);

    let msgQuery = supabaseSvc
      .from("messages_inbox")
      .select("id, remetente, conteudo, message_id_header, in_reply_to_header, references_header, raw_payload")
      .eq("card_id", cardId)
      .eq("canal", "email");

    if (mensagemOrigemId) {
      msgQuery = msgQuery.eq("id", mensagemOrigemId);
    } else {
      msgQuery = msgQuery.order("recebido_em", { ascending: false }).limit(1);
    }

    const { data: msgs } = await msgQuery;
    const origem = (msgs ?? [])[0] as Record<string, unknown> | undefined;
    if (!origem) {
      return json({
        ok: false,
        error: "Não achei mensagem inbound nesse card pra responder.",
      }, 404);
    }

    // 3. Refresh access_token se preciso
    const accessToken = await refreshAccessToken(supabaseSvc, op.id as string, creds, env);

    // 4. Extrai subject original do raw_payload (Postmark)
    const rawPostmark = (origem["raw_payload"] ?? {}) as Record<string, unknown>;
    const subjectOrig = (rawPostmark["Subject"] as string | undefined) ?? "Sua mensagem";
    const subject = /^re:\s/i.test(subjectOrig) ? subjectOrig : `Re: ${subjectOrig}`;

    // To = remetente original (preserva thread Gmail via In-Reply-To).
    // Cc = lista opcional de contatos extras do cliente (multi-select da
    // operadora). Filtra duplicatas pra não copiar pra quem já está no TO.
    // Regra Caio 2026-05-05: 1 ÚNICO envio Gmail com TO+Cc, nunca múltiplos
    // emails separados (cliente entende como 'todos copiados na mesma msg').
    const to = origem["remetente"] as string;
    const toLower = (to ?? "").toLowerCase();
    const ccLista = ccBruto
      .map((e) => e.trim())
      .filter((e) => e.length > 0 && e.toLowerCase() !== toLower);

    // Headers de thread
    const msgIdOrigem = (origem["message_id_header"] as string | null) ?? null;
    const refsOrigem = (origem["references_header"] as string | null) ?? null;
    const novoReferences = montaReferences(refsOrigem, msgIdOrigem);

    // 5. Caio 2026-05-06: usa sendGmailMessage (suporte a anexos + threading)
    // em vez de montar MIME inline.
    const { sendGmailMessage } = await import("../_shared/gmail-sender.ts");
    const { carregarAnexosParaEnvio, finalizarAnexosPosEnvio } = await import("../_shared/anexos-storage.ts");
    void accessToken; // gmail-sender refresha de novo (idempotente)

    const attachments = anexosIds.length > 0
      ? await carregarAnexosParaEnvio(supabaseSvc, anexosIds)
      : [];

    const extraHeaders: Record<string, string> = {};
    if (msgIdOrigem) extraHeaders["In-Reply-To"] = msgIdOrigem;
    if (novoReferences) extraHeaders["References"] = novoReferences;

    const sendResult = await sendGmailMessage({
      supabase: supabaseSvc,
      operadorId: op.id as string,
      destinatario: to,
      cc: ccLista,
      subject,
      texto,
      fromName: op.nome as string | null,
      attachments,
      extraHeaders,
    });

    if (!sendResult.ok) {
      return json({ ok: false, error: sendResult.error }, 500);
    }

    if (attachments.length > 0) {
      await finalizarAnexosPosEnvio(
        supabaseSvc,
        attachments.map((a) => ({ storage_path: a.storage_path, meta_id: a.meta_id })),
      );
    }

    const gmailMessageId = sendResult.messageId ?? undefined;
    const threadId = sendResult.threadId ?? undefined;

    // 7. Audit em card_events
    await supabaseSvc.from("card_events").insert({
      card_id: cardId,
      event_type: "RespostaManualEnviadaPeloCockpit",
      actor_type: "operator",
      actor_id: op.id,
      payload: {
        via: "gmail_oauth",
        from: creds.email,
        to,
        cc: ccLista,
        subject,
        in_reply_to: msgIdOrigem,
        references: novoReferences,
        gmail_message_id: gmailMessageId,
        gmail_thread_id: threadId,
        texto_preview: texto.slice(0, 300),
        mensagem_origem_id: origem["id"],
      },
    });

    return json({
      ok: true,
      gmail_message_id: gmailMessageId,
      thread_id: threadId,
      from: creds.email,
      to,
      cc: ccLista,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("responder-email-cliente fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

async function refreshAccessToken(
  supabase: ReturnType<typeof createClient>,
  operadorId: string,
  creds: { refresh_token: string; email: string; access_token_cache?: string; access_token_expira_em?: string },
  env: Record<string, string>,
): Promise<string> {
  const expira = creds.access_token_expira_em ? new Date(creds.access_token_expira_em).getTime() : 0;
  if (creds.access_token_cache && expira - Date.now() > 60_000) {
    return creds.access_token_cache;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env["GOOGLE_OAUTH_CLIENT_ID"]!,
      client_secret: env["GOOGLE_OAUTH_CLIENT_SECRET"]!,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const j = await res.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    throw new Error(`Gmail token refresh: ${j.error_description ?? j.error ?? `HTTP ${res.status}`}`);
  }

  await supabase
    .from("operadores")
    .update({
      gmail_oauth_credentials: {
        ...creds,
        access_token_cache: j.access_token,
        access_token_expira_em: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString(),
      },
    })
    .eq("id", operadorId);

  return j.access_token;
}

function montaReferences(refsOrigem: string | null, msgIdOrigem: string | null): string | null {
  // Header References: cadeia de Message-IDs anteriores (separados por espaço).
  // Quando responde, adiciona o Message-ID do email atual à cadeia.
  if (!msgIdOrigem) return refsOrigem;
  const partes: string[] = [];
  if (refsOrigem) partes.push(refsOrigem.trim());
  partes.push(msgIdOrigem.trim());
  return partes.join(" ");
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
