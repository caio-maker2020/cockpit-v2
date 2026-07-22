// =============================================================================
// enviar-resposta — consome pgmq.respostas_envio e dispara Postmark transactional.
//
// Disparado por:
//   1. Cron a cada 1min (segurança)
//   2. RPC enviar_resposta_cliente envia HTTP direto (cascata, ~5s latência)
//
// Comportamento:
//   - Lê N msgs da fila respostas_envio
//   - Pra cada uma:
//     * Se ENVIO_DESABILITADO=true → loga e marca todo como "envio_bloqueado"
//       (NÃO consome a msg da fila — fica lá pra quando flag virar)
//       OPCIONAL: marca todo.status='enviando_bloqueado'
//     * Senão: chama Postmark API com From=operador.email_relacionamento
//     * Em sucesso: marca todo.status='enviado', card_event RespostaEnviada,
//       deleta da fila
//     * Em falha permanente (4xx Postmark): marca todo.status='falhou',
//       card_event RespostaEnvioFalhou, archive_to_dead_letter
//     * Em falha transitória (5xx ou network): deixa vt expirar pra retry
//
// Flag ENVIO_DESABILITADO existe pra fase preparação. Quando Caio liberar
// segunda, vira ENVIO_DESABILITADO=false e a fila acumulada começa a ser
// drenada na próxima invocação.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const VT_SECONDS = 120;
const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 5;

interface QueueMessage {
  msg_id: number;
  read_ct: number;
  message: {
    todo_id: string;
    card_id: string;
    canal: "email" | "whatsapp" | "sistema";
    from_email: string;
    from_name: string;
    destinatario: string;
    cc?: string[] | null;
    subject: string | null;
    texto: string;
    operador_id: string;
  };
}

interface RunSummary {
  read: number;
  enviados: number;
  bloqueados_por_flag: number;
  falhas: number;
  archived: number;
  errors: Array<{ todo_id?: string; message: string }>;
  duration_ms: number;
}

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

serve(async (req) => {
  const startedAt = Date.now();
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

    const envioDesabilitado = (env["ENVIO_DESABILITADO"] ?? "true").toLowerCase() === "true";
    const postmarkToken = env["POSTMARK_SERVER_TOKEN"];

    if (!postmarkToken && !envioDesabilitado) {
      throw new Error("POSTMARK_SERVER_TOKEN não configurado e ENVIO_DESABILITADO=false — refusing to run");
    }

    const { data: msgs, error: readErr } = await supabase.rpc("read_from_pgmq", {
      queue_name: "respostas_envio",
      vt_seconds: VT_SECONDS,
      qty: BATCH_SIZE,
    });

    if (readErr) throw new Error(`read_from_pgmq: ${readErr.message}`);

    const queue = (msgs ?? []) as QueueMessage[];
    const summary: RunSummary = {
      read: queue.length,
      enviados: 0,
      bloqueados_por_flag: 0,
      falhas: 0,
      archived: 0,
      errors: [],
      duration_ms: 0,
    };

    for (const job of queue) {
      try {
        if (envioDesabilitado) {
          await markBloqueadoPorFlag(supabase, job);
          summary.bloqueados_por_flag++;
          // NÃO deleta da fila — fica acumulado pra quando flag virar.
          // Mas precisa avançar VT pra não ler de novo no mesmo batch:
          // pgmq.read já fez VT → próxima leitura só após VT expirar.
          continue;
        }

        // Tenta Gmail OAuth primeiro (operadora autenticada). Se não tem
        // credentials, fallback Postmark. Gmail dá 0% spam (reputação Google
        // herdada do Workspace).
        const operadorCreds = await loadOperadorGmailCreds(supabase, job.message.operador_id);
        if (operadorCreds) {
          await sendViaGmail(supabase, job, operadorCreds);
        } else {
          await sendViaPostmark(supabase, job, postmarkToken!);
        }
        summary.enviados++;

        // Sucesso → deleta da fila
        await supabase.rpc("delete_from_pgmq", {
          queue_name: "respostas_envio",
          msg_id: job.msg_id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.errors.push({ todo_id: job.message.todo_id, message: msg });
        summary.falhas++;

        if (job.read_ct >= MAX_ATTEMPTS) {
          await markFalhouPermanente(supabase, job, msg);
          await supabase.rpc("archive_to_dead_letter", {
            source_queue: "respostas_envio",
            source_msg_id: job.msg_id,
            motivo: `enviar-resposta: ${msg.slice(0, 200)} (após ${job.read_ct} tentativas)`,
            original_payload: job.message,
          });
          summary.archived++;
        }
        // Senão deixa o vt expirar pra retry
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    console.log("enviar-resposta done:", JSON.stringify(summary));

    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("enviar-resposta fatal:", msg);
    return new Response(
      JSON.stringify({ error: msg, duration_ms: Date.now() - startedAt }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// =============================================================================

type SupabaseClient = ReturnType<typeof createClient>;

async function markBloqueadoPorFlag(supabase: SupabaseClient, job: QueueMessage): Promise<void> {
  const m = job.message;
  // Não muda status do todo — segue 'enviando' pra quando flag liberar processar.
  // Loga 1x por job pra Caio ver no log que tá esperando flag.
  console.log(`[BLOQUEADO_POR_FLAG] todo=${m.todo_id} canal=${m.canal} → ${m.destinatario}`);

  // Card_event 1x por job, mas evita spam: só insere se ainda não tem.
  // Pra simplicidade, não dedupica — sync futuro pode condensar se incomodar.
  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: "RespostaEnvioBloqueadoPorFlag",
    actor_type: "system",
    actor_id: "enviar-resposta",
    payload: {
      todo_id: m.todo_id,
      motivo: "ENVIO_DESABILITADO=true (fase preparação)",
      tentativa: job.read_ct,
    },
  });
}

async function sendViaPostmark(
  supabase: SupabaseClient,
  job: QueueMessage,
  token: string,
): Promise<void> {
  const m = job.message;

  if (m.canal !== "email") {
    throw new Error(`Canal ${m.canal} ainda não suportado — só email por enquanto`);
  }

  const fromHeader = m.from_name
    ? `${m.from_name} <${m.from_email}>`
    : m.from_email;

  const subject = m.subject ?? "Resposta Sal Express";

  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify({
      From: fromHeader,
      To: m.destinatario,
      Subject: subject,
      TextBody: m.texto,
      MessageStream: "outbound",
      Tag: "cockpit-resposta",
      Metadata: {
        card_id: m.card_id,
        todo_id: m.todo_id,
        operador_id: m.operador_id,
      },
    }),
  });

  const responseBody = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(responseBody); } catch { /* ignore */ }

  if (!res.ok) {
    // 4xx geralmente é falha permanente (sender não verificado, email inválido)
    // 5xx é transitório
    const isPermanent = res.status >= 400 && res.status < 500;
    throw new Error(
      `Postmark ${res.status}${isPermanent ? " (permanent)" : " (transient)"}: ${responseBody.slice(0, 300)}`,
    );
  }

  const messageId = parsed?.["MessageID"] as string | undefined;
  const submittedAt = parsed?.["SubmittedAt"] as string | undefined;

  // Marca todo como enviado
  await supabase
    .from("todos")
    .update({ status: "enviado" })
    .eq("id", m.todo_id);

  // Registra envio com sucesso
  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: "RespostaEnviada",
    actor_type: "system",
    actor_id: "enviar-resposta",
    payload: {
      todo_id: m.todo_id,
      canal: m.canal,
      from: fromHeader,
      destinatario: m.destinatario,
      subject,
      postmark_message_id: messageId,
      postmark_submitted_at: submittedAt,
      texto_preview: m.texto.slice(0, 300),
    },
  });

  // Atualiza state do card pós-envio:
  // Se respondeu cliente após autorização (ação executada), some do Kanban
  // ou fica em AGUARDANDO_TERCEIRO (esperando SSW propagar). Por enquanto,
  // não muda state — quem dita é sync-bastao próximo. Só loga.

  // Cobrança automática REMOVIDA (Caio/Matheus 2026-07-17, mig 298): não
  // agendar mais nada aqui. Era uma das 4 portas que mantiveram a fila de
  // acoes_agendadas crescendo após a mig 168 até saturar (INV-039).
}

// =============================================================================
// Gmail OAuth — envio direto via Gmail API
// =============================================================================

interface GmailCreds {
  refresh_token: string;
  email: string;
  scope?: string;
  conectado_em?: string;
  access_token_cache?: string;
  access_token_expira_em?: string;
}

async function loadOperadorGmailCreds(
  supabase: SupabaseClient,
  operadorId: string,
): Promise<GmailCreds | null> {
  if (!operadorId) return null;
  const { data } = await supabase
    .from("operadores")
    .select("gmail_oauth_credentials")
    .eq("id", operadorId)
    .maybeSingle();
  const creds = (data as Record<string, unknown> | null)?.["gmail_oauth_credentials"] as
    | GmailCreds
    | null
    | undefined;
  if (!creds || !creds.refresh_token) return null;
  return creds;
}

async function refreshGmailAccessToken(
  supabase: SupabaseClient,
  operadorId: string,
  creds: GmailCreds,
): Promise<string> {
  // Reusa access_token cache se ainda válido (margem 60s)
  const expira = creds.access_token_expira_em ? new Date(creds.access_token_expira_em).getTime() : 0;
  if (creds.access_token_cache && expira - Date.now() > 60_000) {
    return creds.access_token_cache;
  }

  const env = Deno.env.toObject();
  const clientId = env["GOOGLE_OAUTH_CLIENT_ID"];
  const clientSecret = env["GOOGLE_OAUTH_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID/SECRET ausentes");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Gmail token refresh: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  }

  // Atualiza cache no banco (reduz refreshes nas próximas envios)
  await supabase
    .from("operadores")
    .update({
      gmail_oauth_credentials: {
        ...creds,
        access_token_cache: json.access_token,
        access_token_expira_em: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
      },
    })
    .eq("id", operadorId);

  return json.access_token;
}

async function sendViaGmail(
  supabase: SupabaseClient,
  job: QueueMessage,
  creds: GmailCreds,
): Promise<void> {
  const m = job.message;
  if (m.canal !== "email") {
    throw new Error(`Canal ${m.canal} ainda não suportado — só email por enquanto`);
  }

  const accessToken = await refreshGmailAccessToken(supabase, m.operador_id, creds);

  // Compose RFC 2822. From usa o email autorizado (creds.email). Mesmo se
  // m.from_email vier diferente, Gmail só permite enviar como o usuário
  // autenticado (ou aliases configurados — fora de escopo).
  const fromHeader = m.from_name ? `${m.from_name} <${creds.email}>` : creds.email;
  const subject = m.subject ?? "Resposta Sal Express";

  const subjectEncoded = `=?UTF-8?B?${b64(subject)}?=`;
  const ccList = Array.isArray(m.cc) ? m.cc.filter((s) => typeof s === "string" && s.trim()) : [];
  const headerLines = [
    `From: ${fromHeader}`,
    `To: ${m.destinatario}`,
  ];
  if (ccList.length > 0) headerLines.push(`Cc: ${ccList.join(", ")}`);
  headerLines.push(
    `Subject: ${subjectEncoded}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  );
  const headers = headerLines.join("\r\n");
  const rawMessage = `${headers}\r\n\r\n${m.texto}`;

  // Gmail API espera base64url do RFC 2822 raw message
  const raw = b64url(rawMessage);

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  const respText = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(respText); } catch { /* ignore */ }

  if (!res.ok) {
    const isPermanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw new Error(`Gmail ${res.status}${isPermanent ? " (permanent)" : " (transient)"}: ${respText.slice(0, 300)}`);
  }

  const messageId = parsed?.["id"] as string | undefined;
  const threadId = parsed?.["threadId"] as string | undefined;

  await supabase
    .from("todos")
    .update({ status: "enviado" })
    .eq("id", m.todo_id);

  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: "RespostaEnviada",
    actor_type: "system",
    actor_id: "enviar-resposta",
    payload: {
      todo_id: m.todo_id,
      canal: m.canal,
      via: "gmail_oauth",
      from: fromHeader,
      destinatario: m.destinatario,
      subject,
      gmail_message_id: messageId,
      gmail_thread_id: threadId,
      texto_preview: m.texto.slice(0, 300),
    },
  });

  // Cobrança automática REMOVIDA (Caio/Matheus 2026-07-17, mig 298) — ver
  // comentário no path Postmark acima.
}

function b64(s: string): string {
  // btoa não suporta UTF-8 — converte via TextEncoder
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64url(s: string): string {
  return b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function markFalhouPermanente(
  supabase: SupabaseClient,
  job: QueueMessage,
  motivo: string,
): Promise<void> {
  const m = job.message;
  await supabase
    .from("todos")
    .update({ status: "falhou", rejection_reason: motivo.slice(0, 500) })
    .eq("id", m.todo_id);

  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: "RespostaEnvioFalhou",
    actor_type: "system",
    actor_id: "enviar-resposta",
    payload: {
      todo_id: m.todo_id,
      motivo,
      tentativas: job.read_ct,
    },
  });
}
