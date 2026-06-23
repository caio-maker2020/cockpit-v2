// =============================================================================
// scan-email-pre-card — Edge Function (Deno runtime)
//
// Caio 2026-06-22: no NASCIMENTO do card (Bastão/extravio/email-ssw), busca no
// Gmail do operador responsável se já existe uma thread daquele CLIENTE sobre
// aquela NF — conversa que o cliente/base abriu ANTES de qualquer card e que o
// Cockpit nunca viu (perde tracking). Se acha, grava sugestão no card
// (cards.email_preexistente_sugerido) pro operador validar e decidir: Seguir
// nesta thread (adoção) ou Abrir e-mail novo.
//
// Trava dura (scan-email-scoring): NF presente (assunto/corpo — garantido pela
// query) E vínculo robusto de cliente (participante com domínio de uma das
// partes do card). Nunca subir e-mail de NF que não seja do cliente.
//
// Consome 2 filas pgmq:
//   - scan_email_pre_card     → este arquivo (ramo SCAN, abaixo)
//   - importar_thread_adotada → Fase 5 (adoção)
//
// Cron 2min (migration 230). Gated por feature_flag scan_email_pre_card_enabled.
// READ-ONLY no Gmail: nunca marca lido nem aplica label.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  loadOperadorGmailCreds,
  refreshGmailAccessToken,
} from "../_shared/gmail-sender.ts";
import {
  baixarAttachment,
  buscarMensagensPorQuery,
  extrairAnexos,
  extrairTexto,
  getHeader,
  getMensagemFull,
  getMensagemMetadata,
  getThreadMin,
  normalizeMessageId,
} from "../_shared/gmail-reader.ts";
import {
  assuntoContemNf,
  type CandidatoEmail,
  normalizarNf,
  pontuarCandidato,
  selecionarSugestoes,
  type ScoreResult,
  slugNome,
  type VinculoCliente,
} from "../_shared/scan-email-scoring.ts";

const VT_SECONDS = 120;
const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 3;
const JANELA_DIAS = 60;
const MAX_THREADS = 5; // threads candidatas inspecionadas a fundo por card
const MAX_MSGS_THREAD = 12; // msgs lidas por thread (participantes + preview)
const PREVIEW_MAX = 8; // msgs guardadas no preview p/ o front renderizar em balões
const MAX_SUGESTOES = 3;

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;

interface ScanMsg {
  card_id: string;
  nf?: string | null;
  cnpj_pagador?: string | null;
  assigned_operator_id?: string | null;
  origem?: string | null;
  // 'nascimento' (default, scan no INSERT) | 'card_em_espera' (thread divergente).
  contexto?: string | null;
  // Opção 1 (Caio 2026-06-23): se vier, foca SÓ nessa thread (gatilho por e-mail
  // novo no poll) — sem busca retroativa por NF.
  thread_hint?: string | null;
}

interface QueueRow {
  msg_id: number;
  read_ct: number;
  message: ScanMsg;
}

interface AdocaoMsg {
  card_id: string;
  gmail_thread_id: string;
  operador_id?: string | null;
}

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

serve(async (req) => {
  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResp({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let body: Record<string, unknown> = {};
  try {
    if (req.method === "POST") body = await req.json();
  } catch { /* sem body */ }

  // Debug: força o scan de UM card (sem fila) e devolve o resultado.
  if (body.scan_card_id && typeof body.scan_card_id === "string") {
    try {
      const r = await processarScanJob(supabase, {
        card_id: body.scan_card_id,
        contexto: typeof body.contexto === "string" ? body.contexto : undefined,
      });
      return jsonResp({ ok: true, debug: true, resultado: r });
    } catch (err) {
      return jsonResp({ ok: false, debug: true, error: String(err) }, 500);
    }
  }

  // Gate: feature flag global.
  if (!(await flagAtiva(supabase, "scan_email_pre_card_enabled"))) {
    return jsonResp({ ok: true, skipped: "flag_off" });
  }

  const { data: msgs, error: readErr } = await supabase.rpc("read_from_pgmq", {
    queue_name: "scan_email_pre_card",
    vt_seconds: VT_SECONDS,
    qty: BATCH_SIZE,
  });
  if (readErr) return jsonResp({ ok: false, error: `read_from_pgmq: ${readErr.message}` }, 500);

  const queue = (msgs ?? []) as QueueRow[];
  const summary = { lidos: queue.length, sugeridos: 0, sem_candidato: 0, duration_ms: 0, erros: [] as string[] };

  for (const job of queue) {
    try {
      const r = await processarScanJob(supabase, job.message);
      if (r.resultado === "sugerido") summary.sugeridos++;
      else summary.sem_candidato++;
      await supabase.rpc("delete_from_pgmq", { queue_name: "scan_email_pre_card", msg_id: job.msg_id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.erros.push(`card=${job.message?.card_id}: ${msg}`);
      // Erro transiente: deixa o vt expirar pra retry. Após MAX_ATTEMPTS,
      // desiste (delete) e loga — scan é enriquecimento, não bloqueia nada.
      if (job.read_ct >= MAX_ATTEMPTS) {
        await registrarLog(supabase, job.message?.card_id, {
          nf: job.message?.nf ?? null,
          operador_id: job.message?.assigned_operator_id ?? null,
          candidatos_total: 0,
          resultado: "erro",
          erro: msg.slice(0, 500),
        });
        await supabase.rpc("delete_from_pgmq", { queue_name: "scan_email_pre_card", msg_id: job.msg_id });
      }
    }
  }

  // Ramo ADOÇÃO: "Seguir nesta thread" enfileira importar_thread_adotada.
  // Importa o histórico, ancora o thread_id e seta tratativa_email_escolhida.
  const adocao = { lidos: 0, adotados: 0, erros: [] as string[] };
  const { data: adMsgs } = await supabase.rpc("read_from_pgmq", {
    queue_name: "importar_thread_adotada",
    vt_seconds: VT_SECONDS,
    qty: BATCH_SIZE,
  });
  const adQueue = (adMsgs ?? []) as Array<{ msg_id: number; read_ct: number; message: AdocaoMsg }>;
  adocao.lidos = adQueue.length;
  for (const job of adQueue) {
    try {
      await processarAdocaoJob(supabase, job.message);
      adocao.adotados++;
      await supabase.rpc("delete_from_pgmq", { queue_name: "importar_thread_adotada", msg_id: job.msg_id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      adocao.erros.push(`card=${job.message?.card_id}: ${msg}`);
      if (job.read_ct >= MAX_ATTEMPTS) {
        await supabase.rpc("delete_from_pgmq", { queue_name: "importar_thread_adotada", msg_id: job.msg_id });
      }
    }
  }

  summary.duration_ms = Date.now() - startedAt;
  return jsonResp({ ok: true, ...summary, adocao });
});

// ---------------------------------------------------------------------------
// Núcleo: roda o scan de UM card e grava sugestão + log. Retorna { resultado }.
// ---------------------------------------------------------------------------
async function processarScanJob(
  supabase: SupabaseClient<any, any, any>,
  msg: ScanMsg,
): Promise<{ resultado: string; candidatos_total: number; melhor_score?: number }> {
  const cardId = msg.card_id;

  const { data: cardRow } = await supabase
    .from("cards")
    .select("id, nf, created_at, assigned_operator_id, agent_state, pagador")
    .eq("id", cardId)
    .maybeSingle();
  const card = cardRow as
    | {
      id: string;
      nf: string | null;
      created_at: string;
      assigned_operator_id: string | null;
      agent_state: Record<string, unknown> | null;
      pagador: string | null;
    }
    | null;
  if (!card) return { resultado: "card_inexistente", candidatos_total: 0 };

  const operadorId = card.assigned_operator_id ?? msg.assigned_operator_id ?? null;
  const nfNorm = normalizarNf(card.nf ?? msg.nf ?? "");

  if (!nfNorm) {
    await registrarLog(supabase, cardId, { nf: null, operador_id: operadorId, candidatos_total: 0, resultado: "sem_nf" });
    return { resultado: "sem_nf", candidatos_total: 0 };
  }
  if (!operadorId) {
    await registrarLog(supabase, cardId, { nf: card.nf, operador_id: null, candidatos_total: 0, resultado: "sem_operador" });
    return { resultado: "sem_operador", candidatos_total: 0 };
  }

  // gmail-sender tipa o client com um alias local ("bare" SupabaseClient);
  // cast preciso só aqui pra alinhar os genéricos sem afetar runtime.
  const sbGmail = supabase as unknown as Parameters<typeof loadOperadorGmailCreds>[0];
  const creds = await loadOperadorGmailCreds(sbGmail, operadorId);
  if (!creds) {
    await registrarLog(supabase, cardId, { nf: card.nf, operador_id: operadorId, candidatos_total: 0, resultado: "sem_credencial_gmail" });
    return { resultado: "sem_credencial_gmail", candidatos_total: 0 };
  }
  const token = await refreshGmailAccessToken(sbGmail, operadorId, creds);

  // Vínculo de cliente DESTE card (não global).
  const vinc = await montarVinculoCliente(supabase, card.agent_state ?? {}, card.pagador, msg.cnpj_pagador);

  // Opção 1 (Caio 2026-06-23): com thread_hint, foca SÓ nessa thread (e-mail novo
  // detectado pelo poll) — nada de busca retroativa por NF (era a fonte da poluição).
  const threadHint = typeof msg.thread_hint === "string" && msg.thread_hint ? msg.thread_hint : null;
  let query: string;
  let achadasThreads: string[];
  if (threadHint) {
    query = `thread_hint:${threadHint}`;
    achadasThreads = [threadHint];
  } else {
    query = `"${nfNorm}" newer_than:${JANELA_DIAS}d -in:chats`;
    achadasThreads = (await buscarMensagensPorQuery(token, query, { maxResults: 25 })).map((m) => m.threadId);
  }

  // Descarta a PRÓPRIA thread do Cockpit (já rastreada em cards_emails_outbound).
  const { data: outRows } = await supabase
    .from("cards_emails_outbound")
    .select("gmail_thread_id")
    .eq("card_id", cardId);
  const ownThreads = new Set(
    ((outRows ?? []) as Array<{ gmail_thread_id: string | null }>)
      .map((r) => r.gmail_thread_id)
      .filter((t): t is string => !!t),
  );

  // Dedup por thread, tira as do próprio Cockpit.
  const threadIds = [...new Set(achadasThreads)]
    .filter((t) => !ownThreads.has(t))
    .slice(0, MAX_THREADS);

  const avaliados: Array<{ cand: CandidatoEmail; score: ScoreResult; participantes: string[]; preview: unknown[] }> = [];
  for (const threadId of threadIds) {
    const tmin = await getThreadMin(token, threadId).catch(() => null);
    const tmsgs = (tmin?.messages ?? []).slice(0, MAX_MSGS_THREAD);
    if (tmsgs.length === 0) continue;

    const domSet = new Set<string>();
    const emailSet = new Set<string>();
    const preview: unknown[] = [];
    let temSent = false;
    let minDateMs = Number.POSITIVE_INFINITY;
    let assunto = "";

    for (const m of tmsgs) {
      const isSent = (m.labelIds ?? []).includes("SENT");
      if (isSent) temSent = true;
      const dms = m.internalDate ? Number(m.internalDate) : NaN;
      if (!Number.isNaN(dms) && dms < minDateMs) minDateMs = dms;

      const meta = await getMensagemMetadata(token, m.id).catch(() => null);
      if (!meta) continue;
      const subj = getHeader(meta, "Subject") ?? "";
      // prefere o assunto que cita a NF; senão o primeiro não-vazio.
      if ((assunto === "" || (assuntoContemNf(subj, nfNorm) && !assuntoContemNf(assunto, nfNorm))) && subj) {
        assunto = subj;
      }
      const fromEmails = emailsDe(getHeader(meta, "From"));
      for (const e of [...fromEmails, ...emailsDe(getHeader(meta, "To")), ...emailsDe(getHeader(meta, "Cc"))]) {
        const d = dominioDe(e);
        if (d && !d.endsWith("salexpress.com.br")) {
          domSet.add(d);
          emailSet.add(e);
        }
      }
      if (preview.length < PREVIEW_MAX) {
        preview.push({
          direcao: isSent ? "outbound" : "inbound",
          de: fromEmails[0] ?? null,
          ts: Number.isNaN(dms) ? null : new Date(dms).toISOString(),
          snippet: ((meta as { snippet?: string }).snippet ?? "").slice(0, 280),
        });
      }
    }

    const cand: CandidatoEmail = {
      gmail_thread_id: threadId,
      assunto,
      participantes_dominios: [...domSet],
      iniciada_em: Number.isFinite(minDateMs) ? new Date(minDateMs).toISOString() : null,
      qtd_mensagens: tmsgs.length,
      tem_sent_operador: temSent,
    };
    const score = pontuarCandidato(cand, nfNorm, vinc, card.created_at);
    avaliados.push({ cand, score, participantes: [...emailSet], preview });
  }

  const sugestoes = selecionarSugestoes(avaliados.map((a) => ({ cand: a.cand, score: a.score })), MAX_SUGESTOES);

  if (sugestoes.length === 0) {
    await registrarLog(supabase, cardId, {
      nf: card.nf,
      operador_id: operadorId,
      candidatos_total: 0,
      resultado: "nenhum_candidato",
      detalhe: { query, threads_inspecionadas: threadIds.length },
    });
    return { resultado: "nenhum_candidato", candidatos_total: 0 };
  }

  // Monta o jsonb do banner (junta participantes/preview por thread).
  const byThread = new Map(avaliados.map((a) => [a.cand.gmail_thread_id, a]));
  const candidatosJson = sugestoes.map(({ cand, score }) => {
    const extra = byThread.get(cand.gmail_thread_id);
    return {
      gmail_thread_id: cand.gmail_thread_id,
      assunto: cand.assunto,
      score: score.score,
      nf_no_assunto: score.nf_no_assunto,
      iniciada_em: cand.iniciada_em,
      qtd_mensagens: cand.qtd_mensagens,
      tem_sent_operador: cand.tem_sent_operador,
      participantes: extra?.participantes ?? [],
      preview: extra?.preview ?? [],
    };
  });

  const sinal = {
    tipo: "thread_preexistente",
    // 'nascimento' = cliente abriu thread ANTES do card; 'card_em_espera' =
    // card AGUARDANDO_CLIENTE e cliente respondeu numa thread divergente.
    contexto: msg.contexto ?? "nascimento",
    detectado_em: new Date().toISOString(),
    vista_em: null,
    decidido_em: null,
    decisao: null,
    candidatos: candidatosJson,
  };

  await supabase.from("cards").update({ email_preexistente_sugerido: sinal }).eq("id", cardId);

  const melhor = sugestoes[0];
  await registrarLog(supabase, cardId, {
    nf: card.nf,
    operador_id: operadorId,
    candidatos_total: sugestoes.length,
    melhor_score: melhor.score.score,
    melhor_thread_id: melhor.cand.gmail_thread_id,
    resultado: "sugerido",
    detalhe: { query, threads_inspecionadas: threadIds.length },
  });

  return { resultado: "sugerido", candidatos_total: sugestoes.length, melhor_score: melhor.score.score };
}

// ---------------------------------------------------------------------------
// Vínculo de cliente: domínios cadastrados (contatos_cliente p/ os CNPJs do
// card) + slugs dos nomes das partes (remetente/destinatário/pagador).
// ---------------------------------------------------------------------------
async function montarVinculoCliente(
  supabase: SupabaseClient<any, any, any>,
  agentState: Record<string, unknown>,
  pagadorNome: string | null,
  cnpjPagadorMsg: string | null | undefined,
): Promise<VinculoCliente> {
  const cnpjsRaw = [
    agentState["cnpj_pagador"],
    agentState["cnpj_remetente"],
    agentState["cnpj_destinatario"],
    cnpjPagadorMsg,
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  const cnpjs = [...new Set(cnpjsRaw.flatMap((c) => [c, c.replace(/\D/g, "")]).filter(Boolean))];

  const dominios = new Set<string>();
  if (cnpjs.length > 0) {
    const { data } = await supabase
      .from("contatos_cliente")
      .select("identificador, tipo")
      .in("documento_cliente", cnpjs)
      .in("tipo", ["email", "dominio"])
      .eq("ativo", true);
    for (const row of (data ?? []) as Array<{ identificador: string | null; tipo: string }>) {
      const id = row.identificador?.toLowerCase().trim();
      if (!id) continue;
      if (row.tipo === "dominio") dominios.add(id);
      else if (row.tipo === "email") {
        const d = dominioDe(id);
        if (d) dominios.add(d);
      }
    }
  }

  const nomeSlugs = [
    slugNome(agentState["remetente"] as string | null),
    slugNome(agentState["destinatario"] as string | null),
    slugNome(pagadorNome),
  ].filter((s) => s && s.length >= 4);

  return { dominios, nomeSlugs };
}

// ---------------------------------------------------------------------------
// ADOÇÃO: "Seguir nesta thread" — Cockpit assume o canal. Importa o histórico
// (inbound→messages_inbox, envios manuais do operador→cards_emails_outbound),
// ancora o thread_id, seta tratativa_email_escolhida e dispara a sugestão do
// agente sobre a última msg inbound. Idempotente.
// ---------------------------------------------------------------------------
async function processarAdocaoJob(
  supabase: SupabaseClient<any, any, any>,
  msg: AdocaoMsg,
): Promise<void> {
  const cardId = msg.card_id;
  const threadId = msg.gmail_thread_id;
  if (!cardId || !threadId) return;

  const { data: cardRow } = await supabase
    .from("cards")
    .select("id, assigned_operator_id")
    .eq("id", cardId)
    .maybeSingle();
  const card = cardRow as { id: string; assigned_operator_id: string | null } | null;
  if (!card) return;

  const operadorId = msg.operador_id ?? card.assigned_operator_id;
  if (!operadorId) throw new Error("adoção sem operador");

  const sbGmail = supabase as unknown as Parameters<typeof loadOperadorGmailCreds>[0];
  const creds = await loadOperadorGmailCreds(sbGmail, operadorId);
  if (!creds) throw new Error("operador sem credencial Gmail");
  const token = await refreshGmailAccessToken(sbGmail, operadorId, creds);

  const tmin = await getThreadMin(token, threadId);
  const tmsgs = tmin.messages ?? [];

  let inbound = 0;
  let outbound = 0;
  let latestInbound: { id: string; ts: number } | null = null;

  for (const tm of tmsgs) {
    const full = await getMensagemFull(token, tm.id).catch(() => null);
    if (!full) continue;
    const isSent = (full.labelIds ?? []).includes("SENT");
    const subject = getHeader(full, "Subject") ?? "";
    const fromHeader = getHeader(full, "From") ?? "";
    const toHeader = getHeader(full, "To") ?? "";
    const ccHeader = getHeader(full, "Cc") ?? "";
    const messageIdHeader = normalizeMessageId(getHeader(full, "Message-ID"));
    const conteudo = extrairTexto(full);
    const dms = full.internalDate ? Number(full.internalDate) : NaN;
    const tsIso = Number.isNaN(dms) ? new Date().toISOString() : new Date(dms).toISOString();

    if (isSent) {
      // envio manual do operador → ancora thread + histórico outbound.
      // Idempotente: gmail_message_id é UNIQUE.
      await supabase.from("cards_emails_outbound").upsert({
        card_id: cardId,
        todo_id: null,
        operadora_id: operadorId,
        gmail_message_id: tm.id,
        gmail_thread_id: threadId,
        from_email: emailsDe(fromHeader)[0] ?? null,
        to_email: emailsDe(toHeader)[0] ?? null,
        subject,
        message_id_header: messageIdHeader,
        corpo_renderizado: conteudo,
        sent_at: tsIso,
      }, { onConflict: "gmail_message_id" });
      outbound++;
    } else {
      // inbound (cliente/base) → messages_inbox. Idempotente por gmail_message_id.
      const { data: jaExiste } = await supabase
        .from("messages_inbox")
        .select("id")
        .eq("raw_payload->>gmail_message_id", tm.id)
        .limit(1)
        .maybeSingle();
      let inboxId = (jaExiste as { id: string } | null)?.id ?? null;
      if (!inboxId) {
        const { data: ins } = await supabase
          .from("messages_inbox")
          .insert({
            card_id: cardId,
            canal: "email",
            remetente: emailsDe(fromHeader)[0] ?? fromHeader,
            conteudo,
            message_id_header: messageIdHeader,
            in_reply_to_header: getHeader(full, "In-Reply-To"),
            references_header: getHeader(full, "References"),
            raw_payload: {
              gmail_message_id: tm.id,
              gmail_thread_id: threadId,
              from: fromHeader,
              to: toHeader,
              cc: ccHeader,
              subject,
              operador_id: operadorId,
              origem: "scan-email-pre-card",
              match_via: "thread_adotada",
            },
            recebido_em: tsIso,
            // Histórico: NÃO enfileira agent_intake (não reprocessa IA na conversa antiga).
            processing_status: "processed",
          })
          .select("id")
          .single();
        inboxId = (ins as { id: string } | null)?.id ?? null;
        if (inboxId) await importarAnexosInbound(supabase, token, tm.id, full, cardId, inboxId);
      }
      inbound++;
      if (inboxId && (!latestInbound || (!Number.isNaN(dms) && dms > latestInbound.ts))) {
        latestInbound = { id: inboxId, ts: Number.isNaN(dms) ? 0 : dms };
      }
    }
  }

  // Ancora a tratativa: respostas futuras vão NESTA thread (executor lê isto via
  // carregarThreadDaTratativaAtual). Reusa a coluna da mig 212.
  await supabase.from("cards").update({ tratativa_email_escolhida: threadId }).eq("id", cardId);
  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "ThreadPreexistenteImportada",
    actor_type: "system",
    actor_id: "scan-email-pre-card",
    payload: { gmail_thread_id: threadId, inbound, outbound },
  });

  // O cliente respondeu NESTA thread → move o card pra CLIENTE RESPONDEU, igual
  // ao vinculador faz numa resposta normal (INV-006: a exceção de AGUARDANDO_
  // CLIENTE é justamente cliente_respondeu_em != null). Só transiciona o state a
  // partir de AGUARDANDO_CLIENTE; em outros states só marca o sinal. A adoção é
  // confirmada pelo operador, então a transição é deliberada (não automática).
  if (latestInbound) {
    const { data: stRow } = await supabase.from("cards").select("state").eq("id", cardId).maybeSingle();
    const estadoAtual = (stRow as { state?: string } | null)?.state;
    const upd: Record<string, unknown> = { cliente_respondeu_em: new Date().toISOString() };
    if (estadoAtual === "AGUARDANDO_CLIENTE") {
      upd.state = "AGUARDANDO_VALIDACAO_HUMANA";
      upd.lock_aguardando_validacao = true;
    }
    await supabase.from("cards").update(upd).eq("id", cardId);
    // Cancela cobrança automática agendada (cliente já respondeu — mesma do vinculador).
    try {
      await supabase.rpc("cancelar_acoes_agendadas_do_card", {
        p_card_id: cardId,
        p_motivo: "cliente respondeu em thread adotada (scan-email-pre-card)",
      });
    } catch (_e) { /* best-effort */ }

    // Agente sugere a próxima ação a partir da conversa: reusa interpretador-
    // resposta-cliente sobre a última msg inbound. O prompt dele já respeita a
    // regra de mínimo de e-mail (cliente já ciente/inconclusivo → oc sem novo
    // e-mail). Best-effort: falha não derruba a adoção.
    try {
      const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
      await fetch(`${base}/functions/v1/interpretador-resposta-cliente`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`,
        },
        body: JSON.stringify({ card_id: cardId, message_id: latestInbound.id }),
      });
    } catch (e) {
      console.log(`[scan-email-pre-card] interpretador pós-adoção falhou: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function importarAnexosInbound(
  supabase: SupabaseClient<any, any, any>,
  token: string,
  gmailMsgId: string,
  full: Parameters<typeof extrairAnexos>[0],
  cardId: string,
  inboxId: string,
): Promise<void> {
  for (const anexo of extrairAnexos(full)) {
    if (anexo.sizeBytes > ANEXO_MAX_BYTES) continue;
    if (!MIMES_PERMITIDOS.has(anexo.mimeType.toLowerCase())) continue;
    try {
      const bytes = await baixarAttachment(token, gmailMsgId, anexo.attachmentId);
      const safeFilename = anexo.filename.replace(/[^\w.\- ]/g, "_");
      const storagePath = `inbound/${inboxId}/${crypto.randomUUID()}-${safeFilename}`;
      const { error: upErr } = await supabase.storage
        .from("email_anexos")
        .upload(storagePath, bytes, { contentType: anexo.mimeType, upsert: false });
      if (upErr) continue;
      await supabase.from("email_anexos").insert({
        card_id: cardId,
        origem: "inbound",
        message_inbox_id: inboxId,
        storage_path: storagePath,
        filename: anexo.filename,
        mime_type: anexo.mimeType,
        size_bytes: bytes.byteLength,
      });
    } catch (_e) { /* anexo é best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function emailsDe(header: string | null): string[] {
  return (header?.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase());
}
function dominioDe(email: string): string {
  return email.split("@")[1]?.trim() ?? "";
}

async function flagAtiva(supabase: SupabaseClient<any, any, any>, key: string): Promise<boolean> {
  const { data } = await supabase.from("feature_flags").select("enabled").eq("key", key).maybeSingle();
  return (data as { enabled?: boolean } | null)?.enabled === true;
}

async function registrarLog(
  supabase: SupabaseClient<any, any, any>,
  cardId: string | undefined,
  fields: {
    nf?: string | null;
    operador_id?: string | null;
    candidatos_total: number;
    melhor_score?: number;
    melhor_thread_id?: string;
    resultado: string;
    detalhe?: unknown;
    erro?: string;
  },
): Promise<void> {
  if (!cardId) return;
  try {
    await supabase.from("email_preexistente_scan").upsert(
      {
        card_id: cardId,
        nf: fields.nf ?? null,
        operador_id: fields.operador_id ?? null,
        candidatos_total: fields.candidatos_total,
        melhor_score: fields.melhor_score ?? null,
        melhor_thread_id: fields.melhor_thread_id ?? null,
        resultado: fields.resultado,
        detalhe: fields.detalhe ?? null,
        erro: fields.erro ?? null,
        scaneado_em: new Date().toISOString(),
      },
      { onConflict: "card_id" },
    );
  } catch (_e) { /* log é best-effort */ }
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
