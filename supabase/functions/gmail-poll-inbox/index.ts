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
  getMensagemMetadata,
  getThreadMin,
  marcarComoLida,
  getHeader,
  extrairTexto,
  normalizeMessageId,
  extrairAnexos,
  baixarAttachment,
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
  cards_revertidos_por_resposta_operadora: number;
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
    return await debugInspect(supabase, body.operador_email as string | undefined);
  }

  // Debug: inspeciona uma thread específica (todos os msgs com labels +
  // internalDate). Útil pra entender por que detectarRespostasOperadora
  // não disparou.
  if (body.inspect_thread && typeof body.inspect_thread === "string") {
    return await debugInspectThread(supabase, body.inspect_thread as string, body.operador_email as string | undefined);
  }

  // Lista operadores com Gmail OAuth conectado. Caio 2026-05-26 (NF 132109):
  // LEFT JOIN com gmail_polling_state ordena ASC por last_poll_at (NULLS
  // PRIMEIRO) — operador mais defasado é processado primeiro. Antes da
  // mudança, LARISSA consumia o timeout de 150s e DUILIO/DURAFA nunca rodavam.
  const { data: operadoresRaw, error: opErr } = await supabase
    .from("operadores")
    .select("id, email, gmail_oauth_credentials, gmail_polling_state(last_poll_at)")
    .not("gmail_oauth_credentials", "is", null);

  if (opErr) {
    return jsonResp({ ok: false, error: `Listar operadores: ${opErr.message}` }, 500);
  }

  // Ordena: NULL last_poll_at primeiro, depois ASC (mais antigo)
  const operadoresOrdenados = ((operadoresRaw ?? []) as Array<Operador & { gmail_polling_state?: { last_poll_at?: string | null }[] }>)
    .filter((op) => op.gmail_oauth_credentials?.refresh_token)
    .sort((a, b) => {
      const aLast = a.gmail_polling_state?.[0]?.last_poll_at;
      const bLast = b.gmail_polling_state?.[0]?.last_poll_at;
      if (!aLast && !bLast) return 0;
      if (!aLast) return -1;
      if (!bLast) return 1;
      return aLast.localeCompare(bLast); // ASC — mais antigo primeiro
    });

  // Caio 2026-05-26: PARALELIZA — Promise.allSettled garante que erro/timeout
  // em 1 operador NÃO impede os outros. Antes era for sequencial; LARISSA com
  // muita inbox consumia 150s do timeout, DUILIO/DURAFA NUNCA processavam.
  const summaryPromises = operadoresOrdenados.map(async (op): Promise<PollSummary> => {
    const summary: PollSummary = {
      operador_id: op.id,
      operador_email: op.email,
      msgs_listadas: 0,
      msgs_vinculadas: 0,
      msgs_ignoradas: 0,
      cards_revertidos_por_resposta_operadora: 0,
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

    return summary;
  });

  const settled = await Promise.allSettled(summaryPromises);
  const summaries: PollSummary[] = settled.map((s) =>
    s.status === "fulfilled"
      ? s.value
      : { operador_id: "?", operador_email: "?", msgs_listadas: 0, msgs_vinculadas: 0, msgs_ignoradas: 0, cards_revertidos_por_resposta_operadora: 0, erros: [`promise rejected: ${String(s.reason)}`] }
  );

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

  // Caio 2026-05-08: detecta respostas que a operadora mandou direto pelo
  // Gmail (fora do Cockpit). Pra cada card em CLIENTE RESPONDEU, checa o
  // thread; se há SENT após cliente_respondeu_em → reverte pra
  // AGUARDANDO_CLIENTE pra esperar próximo retorno do cliente.
  try {
    const revertidos = await detectarRespostasOperadoraNoGmail(supabase, accessToken, op.id);
    summary.cards_revertidos_por_resposta_operadora = revertidos;
  } catch (err) {
    const msgErr = err instanceof Error ? err.message : String(err);
    summary.erros.push(`detect-resposta-operadora: ${msgErr}`);
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
 * Caio 2026-05-08: detecta respostas que a operadora mandou direto pelo Gmail
 * (fora do Cockpit). Quando Larissa responde manualmente um cliente que tinha
 * acionado a aba CLIENTE RESPONDEU, o card precisa voltar pra AGUARDANDO_CLIENTE
 * pra esperar o próximo retorno do cliente. Sem esse detector, card fica preso
 * em CLIENTE RESPONDEU mesmo após Larissa ter respondido.
 *
 * Como funciona: pra cada card em AGUARDANDO_VALIDACAO_HUMANA com
 * cliente_respondeu_em, busca o thread no Gmail e procura mensagens com label
 * SENT cuja internalDate > cliente_respondeu_em E que NÃO sejam outbound do
 * Cockpit (filtra pelo gmail_message_id em cards_emails_outbound).
 *
 * Idempotência: revert zera cliente_respondeu_em → próximo ciclo o card sai
 * dos candidatos → no-op. Próximo retorno do cliente re-aciona o flow normal
 * (vinculador + IA sugere oc).
 */
async function detectarRespostasOperadoraNoGmail(
  supabase: ReturnType<typeof createClient>,
  accessToken: string,
  operadorId: string,
): Promise<number> {
  const { data: cardsRaw } = await supabase
    .from("cards")
    .select("id, nf, cliente_respondeu_em")
    .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
    .eq("assigned_operator_id", operadorId)
    .not("cliente_respondeu_em", "is", null);

  const cards = (cardsRaw ?? []) as Array<{
    id: string;
    nf: string | null;
    cliente_respondeu_em: string;
  }>;
  if (cards.length === 0) return 0;

  let revertidos = 0;

  for (const card of cards) {
    const { data: outboundRaw } = await supabase
      .from("cards_emails_outbound")
      .select("gmail_thread_id, gmail_message_id")
      .eq("card_id", card.id)
      .order("sent_at", { ascending: false });

    const outbound = (outboundRaw ?? []) as Array<{
      gmail_thread_id: string | null;
      gmail_message_id: string | null;
    }>;
    if (outbound.length === 0) continue;

    const threadId = outbound[0].gmail_thread_id;
    if (!threadId) continue;
    const cockpitMsgIds = new Set(
      outbound.map((o) => o.gmail_message_id).filter((id): id is string => Boolean(id)),
    );

    let thread: { id: string; messages?: Array<{ id: string; labelIds?: string[]; internalDate?: string }> };
    try {
      thread = await getThreadMin(accessToken, threadId);
    } catch (err) {
      console.warn(`[detect-resposta-operadora] thread.get ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Caio 2026-05-08: gate baseado em ordem dos eventos na thread (mais
    // robusto que `SENT.internalDate > cliente_respondeu_em`, que falha se
    // Larissa responde nos segundos antes da nossa flag ser setada). Lógica:
    // se a ÚLTIMA mensagem SENT-não-Cockpit é POSTERIOR à última INBOX,
    // significa que a operadora foi a última a falar → cliente está com a
    // bola, revert pra AGUARDANDO_CLIENTE.
    const msgs = (thread.messages ?? []).slice().sort((a, b) =>
      parseInt(a.internalDate ?? "0", 10) - parseInt(b.internalDate ?? "0", 10)
    );
    const lastInboxTs = msgs
      .filter((m) => m.labelIds?.includes("INBOX"))
      .map((m) => parseInt(m.internalDate ?? "0", 10))
      .reduce((acc, t) => (t > acc ? t : acc), 0);
    if (lastInboxTs === 0) continue; // thread sem reply de cliente, nada a reverter

    const respostaOperadora = [...msgs].reverse().find((m) => {
      if (!m.labelIds?.includes("SENT")) return false;
      if (cockpitMsgIds.has(m.id)) return false;
      return parseInt(m.internalDate ?? "0", 10) > lastInboxTs;
    });

    if (!respostaOperadora) continue;

    const { error: updErr } = await supabase
      .from("cards")
      .update({
        state: "AGUARDANDO_CLIENTE",
        lock_aguardando_validacao: false,
        cliente_respondeu_em: null,
        ia_sugestao_oc_resposta: null,
      })
      .eq("id", card.id);

    if (updErr) {
      console.warn(`[detect-resposta-operadora] UPDATE card ${card.id}: ${updErr.message}`);
      continue;
    }

    await supabase.from("card_events").insert({
      card_id: card.id,
      event_type: "OperadoraRespondeuClienteViaGmail",
      actor_type: "system",
      actor_id: "gmail-poll-inbox",
      payload: {
        gmail_message_id: respostaOperadora.id,
        gmail_thread_id: threadId,
        internal_date: respostaOperadora.internalDate,
        observacao: "Operadora respondeu cliente fora do Cockpit (Gmail direto). Card volta pra AGUARDANDO_CLIENTE; próxima resposta do cliente re-aciona aba CLIENTE RESPONDEU.",
      },
    });

    revertidos++;
  }

  return revertidos;
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
  // Caio 2026-05-08: lookup por thread_id ANTES de fetchar conteúdo.
  // Polling agora lista todo unread (não só label cockpit-tracked) — então
  // a maioria dos itens é email pessoal da Larissa que não tem match.
  // Pular cedo evita gastar Gmail messages.get + preserva privacidade
  // (não marcamos como lido emails que não são do Cockpit).
  let cardId: string | null = null;
  let matchVia: "thread_id" | "fallback_nf_dominio" | null = null;
  if (threadId) {
    const { data } = await supabase
      .from("cards_emails_outbound")
      .select("card_id")
      .eq("gmail_thread_id", threadId)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    cardId = (data as { card_id?: string } | null)?.card_id ?? null;
    if (cardId) matchVia = "thread_id";
  }

  // Caio 2026-05-21 (NF 1008919): fallback quando cliente abre email NOVO
  // em vez de "Responder" (ex: PRATI tem sistema interno que abre subject
  // estruturado "CLIENTE NNN NOTA NNN OC NNN - Assunto: ..."). Sem thread_id
  // match, ANTES o gmail-poll descartava silenciosamente. Agora fetcha
  // metadata da mensagem, extrai NF do subject, e tenta match por
  // (NF + domínio remetente) em outbounds das últimas 48h.
  //
  // Risco: vincular mensagem unsolicited. Mitigação: requer AMBOS NF
  // mencionada E domínio bater contra outbound real do Cockpit.
  // Auditável via raw_payload.match_via = 'fallback_nf_dominio'.
  if (!cardId) {
    const metadata = await getMensagemMetadata(accessToken, messageId).catch(() => null);
    if (metadata) {
      const subject = getHeader(metadata, "Subject") ?? "";
      const from = parseEmailFromHeader(getHeader(metadata, "From") ?? "");
      const nfMatch = subject.match(/NF\s*(\d{4,9})/i);
      const dominio = from.includes("@") ? from.split("@")[1].toLowerCase() : null;

      if (nfMatch && dominio) {
        const nfExtraida = nfMatch[1];
        const { data: outFallback } = await supabase
          .from("cards_emails_outbound")
          .select("card_id, to_email, sent_at, cards!inner(nf)")
          .eq("cards.nf", nfExtraida)
          .ilike("to_email", `%@${dominio}`)
          .gte("sent_at", new Date(Date.now() - 48 * 3600_000).toISOString())
          .order("sent_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const fbCardId = (outFallback as { card_id?: string } | null)?.card_id ?? null;
        if (fbCardId) {
          cardId = fbCardId;
          matchVia = "fallback_nf_dominio";
          console.log(
            `[gmail-poll] match fallback: NF=${nfExtraida} dominio=${dominio} → card=${fbCardId}`,
          );
        }
      }
    }
  }

  if (!cardId) {
    // Thread não-tracked (email pessoal da Larissa ou thread sem outbound
    // do Cockpit). Não marca como lida, não fetcha conteúdo full, não
    // polui messages_inbox. Próximo polling re-lista mas custo é só list.
    return false;
  }

  const msg = await getMensagemFull(accessToken, messageId);

  // Mensagens com label SENT são emails enviados pela própria operadora
  // (ex: Larissa enviou via Cockpit). Não capturar — só queremos respostas
  // do cliente. Marca como lida pra não re-listar.
  if (msg.labelIds?.includes("SENT")) {
    await marcarComoLida(accessToken, messageId).catch(() => {});
    return false;
  }

  const messageIdHeader = normalizeMessageId(getHeader(msg, "Message-ID"));
  const inReplyTo = normalizeMessageId(getHeader(msg, "In-Reply-To"));
  const referencesHeader = getHeader(msg, "References");
  const fromHeader = getHeader(msg, "From") ?? "(unknown)";
  const subjectHeader = getHeader(msg, "Subject") ?? "";
  // Caio 2026-05-27 (NF 647901 DURAFA): preserva To/Cc da mensagem inbound
  // pra que responder-email-cliente possa pré-popular CC com os endereços
  // que o cliente adicionou ao responder. Antes só salvávamos `from` — quando
  // cliente adicionava transporte@isapa.com.br em CC, o sistema perdia.
  const toHeader = getHeader(msg, "To") ?? "";
  const ccHeader = getHeader(msg, "Cc") ?? "";

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

  const remetente = parseEmailFromHeader(fromHeader);

  // Caio 2026-06-02 (NF 5826 MIX MOTO): bounces do mailer-daemon/postmaster
  // estavam sendo vinculados ao card como se fossem resposta do cliente.
  // Vinculador setava cliente_respondeu_em → card aparecia em "CLIENTE
  // RESPONDEU" mesmo sem cliente ter respondido nada. interpretador-resposta
  // classificava como bounce DEPOIS mas dano já estava feito. Filtro aqui
  // impede que bounce vire row em messages_inbox.
  const remetenteLower = remetente.toLowerCase();
  const subjectLower = subjectHeader.toLowerCase();
  const ehBounce =
    remetenteLower.startsWith("mailer-daemon@") ||
    remetenteLower.startsWith("postmaster@") ||
    /mensagem n[ãa]o entreg|undelivered mail|delivery status notification|mail delivery (failed|subsystem)|returned to sender|n[ãa]o foi entregue|delivery has failed/i.test(subjectLower);
  if (ehBounce) {
    // Caio 2026-06-02: registra bounce no card pra front mostrar banner amarelo
    // alertando operadora. Extrai destinatário e motivo do corpo do bounce.
    const conteudoBounce = extrairTexto(msg);
    const destinatarioMatch = conteudoBounce.match(/(?:para|to)\s+([\w.+-]+@[\w.-]+\.\w+)/i);
    const motivoMatch = conteudoBounce.match(/(550[^\n]{0,200})/);
    const payload = {
      destinatario: destinatarioMatch?.[1] ?? null,
      motivo_smtp: motivoMatch?.[1]?.trim() ?? null,
      gmail_message_id: messageId,
      subject_original: subjectHeader,
      detectado_em: new Date().toISOString(),
    };
    await supabase
      .from("cards")
      .update({
        ultimo_bounce_em: new Date().toISOString(),
        ultimo_bounce_payload: payload,
      })
      .eq("id", cardId);
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "BounceDetectado",
      actor_type: "system",
      actor_id: "gmail-poll-inbox",
      payload,
    });
    console.log(
      `[gmail-poll] bounce registrado card=${cardId}: from=${remetente} dest=${payload.destinatario} motivo=${payload.motivo_smtp?.slice(0, 80)}`,
    );
    await marcarComoLida(accessToken, messageId).catch(() => {});
    return false;
  }

  const conteudo = extrairTexto(msg);

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
        // Caio 2026-05-27 (NF 647901 DURAFA): preserva To/Cc da mensagem
        // inbound. Quando cliente respondeu adicionando transporte@isapa
        // em CC, o sistema perdia esses endereços e a próxima resposta do
        // operador saía só pro remetente original.
        to: toHeader,
        cc: ccHeader,
        subject: subjectHeader,
        operador_id: operadorId,
        origem: "gmail-poll-inbox",
        // Caio 2026-05-21: pra auditoria de fallback de match.
        // thread_id = match normal (cliente respondeu o thread original).
        // fallback_nf_dominio = cliente abriu email novo (caso PRATI NF 1008919);
        //   match via (NF no subject + domínio remetente == outbound 48h).
        match_via: matchVia,
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

  // Caio 2026-05-12 (NF 920161): captura anexos do cliente. Upload pro
  // bucket email_anexos com origem='inbound' + message_inbox_id pra Larissa
  // poder reusar (anexar em SSW, baixar). Sem isso ela precisa abrir Gmail.
  const anexos = extrairAnexos(msg);
  const ANEXO_MAX_BYTES = 10 * 1024 * 1024; // 10MB
  const MIMES_PERMITIDOS = new Set([
    "application/pdf",
    "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv", "text/plain",
  ]);
  const inboxId = (inboxRow as { id: string }).id;
  const anexosSalvos: Array<{ id: string; filename: string; mime: string }> = [];
  for (const anexo of anexos) {
    if (anexo.sizeBytes > ANEXO_MAX_BYTES) {
      console.warn(`anexo ${anexo.filename} ignorado (${anexo.sizeBytes} bytes > 10MB)`);
      continue;
    }
    if (!MIMES_PERMITIDOS.has(anexo.mimeType.toLowerCase())) {
      console.warn(`anexo ${anexo.filename} ignorado (mime ${anexo.mimeType} fora da allowlist)`);
      continue;
    }
    try {
      const bytes = await baixarAttachment(accessToken, messageId, anexo.attachmentId);
      const anexoUuid = crypto.randomUUID();
      const safeFilename = anexo.filename.replace(/[^\w.\- ]/g, "_");
      const storagePath = `inbound/${inboxId}/${anexoUuid}-${safeFilename}`;
      const { error: upErr } = await supabase.storage
        .from("email_anexos")
        .upload(storagePath, bytes, { contentType: anexo.mimeType, upsert: false });
      if (upErr) {
        console.warn(`anexo ${anexo.filename} upload falhou: ${upErr.message}`);
        continue;
      }
      const { data: anexoRow, error: insErr } = await supabase
        .from("email_anexos")
        .insert({
          card_id: cardId,
          origem: "inbound",
          message_inbox_id: inboxId,
          storage_path: storagePath,
          filename: anexo.filename,
          mime_type: anexo.mimeType,
          size_bytes: bytes.byteLength,
        })
        .select("id")
        .single();
      if (insErr) {
        console.warn(`anexo ${anexo.filename} INSERT email_anexos falhou: ${insErr.message}`);
        continue;
      }
      anexosSalvos.push({
        id: (anexoRow as { id: string }).id,
        filename: anexo.filename,
        mime: anexo.mimeType,
      });
    } catch (err) {
      console.warn(`anexo ${anexo.filename} erro: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      anexos_count: anexosSalvos.length,
      anexos: anexosSalvos,
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
  operadorEmail?: string,
): Promise<Response> {
  // Caio 2026-05-15 (multi-operador): aceita operador_email pra debug
  // específico (ex: Duilio). Sem param, pega o primeiro com gmail_oauth.
  let query = supabase
    .from("operadores")
    .select("id, email, gmail_oauth_credentials")
    .not("gmail_oauth_credentials", "is", null);
  if (operadorEmail) query = query.eq("email", operadorEmail);
  const { data: ops } = await query.limit(1);
  const op = ops?.[0] as Operador | undefined;
  if (!op) return jsonResp({ ok: false, error: `sem operador ${operadorEmail ?? ''}` }, 404);
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

async function debugInspectThread(
  supabase: ReturnType<typeof createClient>,
  threadId: string,
  operadorEmail?: string,
): Promise<Response> {
  let query = supabase
    .from("operadores")
    .select("id, email, gmail_oauth_credentials")
    .not("gmail_oauth_credentials", "is", null);
  if (operadorEmail) query = query.eq("email", operadorEmail);
  const { data: ops } = await query.limit(1);
  const op = ops?.[0] as Operador | undefined;
  if (!op) return jsonResp({ ok: false, error: `sem operador ${operadorEmail ?? ''}` }, 404);
  const creds = await loadOperadorGmailCreds(supabase, op.id);
  if (!creds) return jsonResp({ ok: false, error: "sem creds" }, 400);
  const accessToken = await refreshGmailAccessToken(supabase, op.id, creds);
  const thread = await getThreadMin(accessToken, threadId);
  return jsonResp({ ok: true, thread_id: threadId, messages: thread.messages ?? [] }, 200);
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
