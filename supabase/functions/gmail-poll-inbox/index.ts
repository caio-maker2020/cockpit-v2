// =============================================================================
// gmail-poll-inbox — Edge Function (Deno runtime)
//
// Caio 2026-05-06: captura respostas dos clientes a emails enviados pelo
// Cockpit (via Gmail OAuth da Larissa). Filtro por label `cockpit-tracked`
// garante zero ruído (não pega emails pessoais).
//
// Pipeline:
//   1. Pra cada operador com gmail_oauth_credentials:
//   2. Refresh access_token
//   3. Garante label cockpit-tracked existe (cacheia ID em gmail_polling_state)
//   4. Lista mensagens não lidas com query: label:cockpit-tracked is:unread newer_than:7d
//   5. Pra cada msg:
//      a. Lookup card_id em cards_emails_outbound via In-Reply-To OU thread_id
//      b. Se acha: INSERT messages_inbox com card_id já preenchido
//      c. Marca como lida (removeLabelIds=UNREAD) pra não reprocessar
//   6. Vinculador (job existente) detecta nova msg + dispara fluxo IA
//
// Roda em cron 5min (migration 061). Latência total cliente→Larissa: ~5min.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  loadOperadorGmailCreds,
  refreshGmailAccessToken,
} from "../_shared/gmail-sender.ts";
import {
  garantirLabelCockpitTracked,
  listarMensagensNaoLidas,
  getMensagemFull,
  marcarComoLida,
  getHeader,
  extrairTexto,
  normalizeMessageId,
} from "../_shared/gmail-reader.ts";

interface Operador {
  id: string;
  email: string | null;
  gmail_oauth_credentials: { refresh_token?: string } | null;
}

interface PollSummary {
  operador_id: string;
  operador_email: string | null;
  msgs_listadas: number;
  msgs_vinculadas: number;
  msgs_ignoradas: number;
  erros: string[];
}

serve(async (req) => {
  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResp({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Admin mode: { force_thread_id: "xxx", operador_email: "larissa@..." }
  // Re-aplica label cockpit-tracked + marca thread como unread → próximo
  // polling re-captura como se fosse nova msg. Útil pra retroativo.
  let body: Record<string, unknown> = {};
  try {
    if (req.method === "POST") body = await req.json();
  } catch { /* sem body */ }

  if (body.force_thread_id && typeof body.force_thread_id === "string") {
    return await reativarThread(supabase, body.force_thread_id as string, body.operador_email as string | undefined);
  }

  // Debug: inspeciona labels das mensagens unread com label cockpit-tracked
  if (body.debug === true) {
    return await debugInspect(supabase);
  }

  // Lista operadores com Gmail OAuth conectado
  const { data: operadoresRaw, error: opErr } = await supabase
    .from("operadores")
    .select("id, email, gmail_oauth_credentials")
    .not("gmail_oauth_credentials", "is", null);

  if (opErr) {
    return jsonResp({ ok: false, error: `Listar operadores: ${opErr.message}` }, 500);
  }

  const operadores = (operadoresRaw ?? []) as Operador[];
  const summaries: PollSummary[] = [];

  for (const op of operadores) {
    const refresh = op.gmail_oauth_credentials?.refresh_token;
    if (!refresh) continue;

    const summary: PollSummary = {
      operador_id: op.id,
      operador_email: op.email,
      msgs_listadas: 0,
      msgs_vinculadas: 0,
      msgs_ignoradas: 0,
      erros: [],
    };

    try {
      await processarOperador(supabase, op, summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.erros.push(`fatal: ${msg}`);
      await supabase.from("gmail_polling_state").upsert({
        operador_id: op.id,
        last_poll_at: new Date().toISOString(),
        last_error: msg,
      });
    }

    summaries.push(summary);
  }

  return jsonResp({
    ok: true,
    duration_ms: Date.now() - startedAt,
    operadores_processados: summaries.length,
    summaries,
  }, 200);
});

async function processarOperador(
  supabase: ReturnType<typeof createClient>,
  op: Operador,
  summary: PollSummary,
): Promise<void> {
  const creds = await loadOperadorGmailCreds(supabase, op.id);
  if (!creds) {
    summary.erros.push("sem creds Gmail");
    return;
  }

  const accessToken = await refreshGmailAccessToken(supabase, op.id, creds);

  // Garante label (cacheia ID em gmail_polling_state)
  const { data: stateRow } = await supabase
    .from("gmail_polling_state")
    .select("cockpit_label_id")
    .eq("operador_id", op.id)
    .maybeSingle();

  let labelId = (stateRow as { cockpit_label_id?: string } | null)?.cockpit_label_id ?? null;
  if (!labelId) {
    labelId = await garantirLabelCockpitTracked(accessToken);
    await supabase.from("gmail_polling_state").upsert({
      operador_id: op.id,
      cockpit_label_id: labelId,
    });
  }

  // Lista mensagens não lidas filtradas por label
  const msgs = await listarMensagensNaoLidas(accessToken);
  summary.msgs_listadas = msgs.length;

  for (const m of msgs) {
    try {
      const processed = await processarMensagem(supabase, accessToken, op.id, m.id, m.threadId);
      if (processed) summary.msgs_vinculadas++;
      else summary.msgs_ignoradas++;
    } catch (err) {
      const msgErr = err instanceof Error ? err.message : String(err);
      summary.erros.push(`msg ${m.id}: ${msgErr}`);
    }
  }

  await supabase.from("gmail_polling_state").upsert({
    operador_id: op.id,
    last_poll_at: new Date().toISOString(),
    last_success_at: new Date().toISOString(),
    last_error: null,
    msgs_processadas_total: (await getCurrentTotal(supabase, op.id)) + summary.msgs_vinculadas,
  });
}

async function getCurrentTotal(
  supabase: ReturnType<typeof createClient>,
  operadorId: string,
): Promise<number> {
  const { data } = await supabase
    .from("gmail_polling_state")
    .select("msgs_processadas_total")
    .eq("operador_id", operadorId)
    .maybeSingle();
  return (data as { msgs_processadas_total?: number } | null)?.msgs_processadas_total ?? 0;
}

/**
 * Processa 1 mensagem: lookup card_id, INSERT messages_inbox, mark as read.
 * Retorna true se vinculou ao card, false se ignorou (sem match em outbound).
 */
async function processarMensagem(
  supabase: ReturnType<typeof createClient>,
  accessToken: string,
  operadorId: string,
  messageId: string,
  threadId: string,
): Promise<boolean> {
  const msg = await getMensagemFull(accessToken, messageId);

  // Mensagens com label SENT são emails enviados pela própria operadora
  // (ex: Larissa enviou via Cockpit). Não capturar — só queremos respostas
  // do cliente.
  if (msg.labelIds?.includes("SENT")) {
    await marcarComoLida(accessToken, messageId).catch(() => {});
    return false;
  }

  const messageIdHeader = normalizeMessageId(getHeader(msg, "Message-ID"));
  const inReplyTo = normalizeMessageId(getHeader(msg, "In-Reply-To"));
  const referencesHeader = getHeader(msg, "References");
  const fromHeader = getHeader(msg, "From") ?? "(unknown)";
  const subjectHeader = getHeader(msg, "Subject") ?? "";

  // Lookup card_id: prioridade In-Reply-To, fallback thread_id
  let cardId: string | null = null;

  if (inReplyTo) {
    // Tenta match por gmail_message_id OU message_id_header
    const { data } = await supabase
      .from("cards_emails_outbound")
      .select("card_id")
      .or(`gmail_message_id.eq.${inReplyTo},message_id_header.eq.${inReplyTo}`)
      .limit(1)
      .maybeSingle();
    cardId = (data as { card_id?: string } | null)?.card_id ?? null;
  }

  if (!cardId && threadId) {
    const { data } = await supabase
      .from("cards_emails_outbound")
      .select("card_id")
      .eq("gmail_thread_id", threadId)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    cardId = (data as { card_id?: string } | null)?.card_id ?? null;
  }

  if (!cardId) {
    // Sem match em outbound — não polui messages_inbox. Marca como lida pra
    // não reprocessar. Provavelmente label foi aplicado a thread externa.
    await marcarComoLida(accessToken, messageId).catch(() => {});
    return false;
  }

  // Idempotência: se já temos essa mensagem em messages_inbox, pula
  if (messageIdHeader) {
    const { data: existing } = await supabase
      .from("messages_inbox")
      .select("id")
      .eq("message_id_header", messageIdHeader)
      .limit(1)
      .maybeSingle();
    if (existing) {
      await marcarComoLida(accessToken, messageId).catch(() => {});
      return false;
    }
  }

  const conteudo = extrairTexto(msg);
  const remetente = parseEmailFromHeader(fromHeader);

  const { data: inboxRow, error: insErr } = await supabase
    .from("messages_inbox")
    .insert({
      card_id: cardId,
      canal: "email",
      remetente,
      conteudo,
      message_id_header: messageIdHeader,
      in_reply_to_header: inReplyTo,
      references_header: referencesHeader,
      raw_payload: {
        gmail_message_id: messageId,
        gmail_thread_id: threadId,
        from: fromHeader,
        subject: subjectHeader,
        operador_id: operadorId,
        origem: "gmail-poll-inbox",
      },
      processing_status: "pending",
    })
    .select("id, recebido_em")
    .single();

  if (insErr) throw new Error(`INSERT messages_inbox: ${insErr.message}`);

  // Enfileira em pgmq.agent_intake — triador → vinculador → IA.
  // Mesmo padrão usado pelo ingestor Postmark (ingestor/index.ts:108).
  const { error: enqErr } = await supabase.rpc("enqueue_to_pgmq", {
    queue_name: "agent_intake",
    payload: {
      message_id: (inboxRow as { id: string }).id,
      canal: "email",
      remetente,
      recebido_em: (inboxRow as { recebido_em: string }).recebido_em,
    },
  });
  if (enqErr) {
    console.warn(`enqueue agent_intake falhou (msg ${(inboxRow as { id: string }).id}): ${enqErr.message}`);
  }

  // Card_event de auditoria
  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "RespostaClienteCapturada",
    actor_type: "system",
    actor_id: "gmail-poll-inbox",
    payload: {
      gmail_message_id: messageId,
      gmail_thread_id: threadId,
      remetente,
      subject: subjectHeader,
      preview: conteudo.slice(0, 300),
    },
  });

  await marcarComoLida(accessToken, messageId).catch(() => {});
  return true;
}

/**
 * Admin: re-aplica label cockpit-tracked + marca thread como unread.
 * Próximo polling captura a mensagem da thread como se fosse nova.
 * Útil pra retroativo (ex: NF que recebeu reply antes do polling existir).
 */
async function reativarThread(
  supabase: ReturnType<typeof createClient>,
  threadId: string,
  operadorEmail: string | undefined,
): Promise<Response> {
  const query = supabase.from("operadores").select("id, email, gmail_oauth_credentials");
  const { data: ops } = operadorEmail
    ? await query.eq("email", operadorEmail).limit(1)
    : await query.not("gmail_oauth_credentials", "is", null).limit(1);

  const op = (ops?.[0] as Operador | undefined);
  if (!op) return jsonResp({ ok: false, error: "operador não encontrado" }, 404);

  const creds = await loadOperadorGmailCreds(supabase, op.id);
  if (!creds) return jsonResp({ ok: false, error: "operador sem creds Gmail" }, 400);

  const accessToken = await refreshGmailAccessToken(supabase, op.id, creds);
  const labelId = await garantirLabelCockpitTracked(accessToken);

  await supabase.from("gmail_polling_state").upsert({
    operador_id: op.id,
    cockpit_label_id: labelId,
  });

  // Aplica label + UNREAD na thread
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ addLabelIds: [labelId, "UNREAD"] }),
    },
  );
  if (!res.ok) {
    return jsonResp({
      ok: false,
      error: `Gmail threads.modify: ${res.status} ${await res.text()}`,
    }, 500);
  }

  return jsonResp({
    ok: true,
    operador_id: op.id,
    operador_email: op.email,
    thread_id: threadId,
    label_id: labelId,
    obs: "Thread reativada. Próximo polling captura.",
  }, 200);
}

async function debugInspect(
  supabase: ReturnType<typeof createClient>,
): Promise<Response> {
  const { data: ops } = await supabase
    .from("operadores")
    .select("id, email, gmail_oauth_credentials")
    .not("gmail_oauth_credentials", "is", null)
    .limit(1);
  const op = ops?.[0] as Operador | undefined;
  if (!op) return jsonResp({ ok: false, error: "sem operador" }, 404);
  const creds = await loadOperadorGmailCreds(supabase, op.id);
  if (!creds) return jsonResp({ ok: false, error: "sem creds" }, 400);
  const accessToken = await refreshGmailAccessToken(supabase, op.id, creds);
  const msgs = await listarMensagensNaoLidas(accessToken);
  const details: Array<Record<string, unknown>> = [];
  for (const m of msgs) {
    const full = await getMensagemFull(accessToken, m.id);
    details.push({
      id: m.id,
      threadId: m.threadId,
      labelIds: full.labelIds,
      from: getHeader(full, "From"),
      subject: getHeader(full, "Subject"),
      inReplyTo: normalizeMessageId(getHeader(full, "In-Reply-To")),
    });
  }
  return jsonResp({ ok: true, msgs: details }, 200);
}

function parseEmailFromHeader(raw: string): string {
  // "Nome <email@x.com>" → "email@x.com"
  const m = raw.match(/<([^>]+)>/);
  if (m) return m[1]!.trim();
  return raw.trim();
}

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
