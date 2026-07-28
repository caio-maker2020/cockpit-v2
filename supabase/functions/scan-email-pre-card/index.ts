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
// Caio 2026-06-23 (NF 761583, INV-016): cria as propostas pós-resposta cliente
// DIRETO aqui (determinístico), sem depender do re-enqueue→triador→vinculador.
// Quando a Anthropic 529 derrubou o triador, a mensagem foi pro DLQ e o card
// ficou em CLIENTE RESPONDEU sem nenhum botão. Agora o operador SEMPRE tem as
// ações, mesmo com LLM fora do ar.
import { atualizarPropostasAposRespostaCliente } from "../_shared/propostas-pos-resposta-cliente.ts";
import { decidirAdocaoThread } from "../_shared/adocao-thread.ts";

const VT_SECONDS = 120;
const BATCH_SIZE = 5;
// Adoção é mais pesada (importa thread + anexos) — 1 por ciclo pra não estourar
// o tempo do edge. Interpretação é async (agent_intake). Cron 2min escoa a fila.
const ADOCAO_BATCH = 1;
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
  // true = adoção AUTOMÁTICA (card_em_espera detectado) — marca a sugestão como
  // confirmada (thread principal) ao fim. false/ausente = adoção manual ("Seguir").
  auto?: boolean;
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

// NF 108141/2184447 (Duílio 2026-07-28): o botão "Já tem tratativa? Buscar"
// chama esta função DO NAVEGADOR (scan_card_id), mas ela não tratava CORS/OPTIONS
// → o browser barrava o POST no preflight → toast "erro de edge function" no
// front, SEM log 4xx/5xx no backend (as chamadas do cron via service-role, que
// não validam CORS, seguiam 200). Espelha o CORS da criar-card-manual (que
// funciona pro operador).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
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

  // Ramo ADOÇÃO processa SEMPRE (mesmo flag OFF): adoção é ação JÁ decidida
  // (auto ou "Seguir"), não pode ficar presa. 1 por ciclo (cron 2min escoa).
  const adocao = { lidos: 0, adotados: 0, pulados: 0, erros: [] as string[] };
  {
    // Incidente 26/07: a fila acumulou 15.052 jobs pra 59 cards. Com a trava de
    // idempotência, job repetido custa 1 leitura e vira "pulado" — então ele é
    // DRENADO em série (orçamento de tempo), enquanto a adoção REAL (pesada:
    // Gmail + anexos + IA) continua 1 por ciclo, como sempre foi.
    const ADOCAO_DRENO_MS = 20_000;
    const iniciouAdocao = Date.now();
    while (Date.now() - iniciouAdocao < ADOCAO_DRENO_MS) {
      const { data: adMsgs } = await supabase.rpc("read_from_pgmq", {
        queue_name: "importar_thread_adotada",
        vt_seconds: VT_SECONDS,
        qty: ADOCAO_BATCH,
      });
      const adQueue = (adMsgs ?? []) as Array<{ msg_id: number; read_ct: number; message: AdocaoMsg }>;
      if (adQueue.length === 0) break;
      adocao.lidos += adQueue.length;
      let fezTrabalhoPesado = false;
      for (const job of adQueue) {
        try {
          const r = await processarAdocaoJob(supabase, job.message);
          if (r === "adotado") { adocao.adotados++; fezTrabalhoPesado = true; }
          else adocao.pulados++;
          await supabase.rpc("delete_from_pgmq", { queue_name: "importar_thread_adotada", msg_id: job.msg_id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          adocao.erros.push(`card=${job.message?.card_id}: ${msg}`);
          if (job.read_ct >= MAX_ATTEMPTS) {
            await supabase.rpc("delete_from_pgmq", { queue_name: "importar_thread_adotada", msg_id: job.msg_id });
          }
        }
      }
      // Adoção real feita neste ciclo → para (mantém o ritmo de 1/ciclo).
      if (fezTrabalhoPesado) break;
    }
  }

  // Gate: feature flag global (só p/ o SCAN/detecção; adoção já rodou acima).
  if (!(await flagAtiva(supabase, "scan_email_pre_card_enabled"))) {
    return jsonResp({ ok: true, skipped: "flag_off", adocao });
  }

  // Auditoria 25/07: fila com 94k de backlog e consumo de 1 lote de 5 por
  // invocação (cron 2min) = job novo esperando ~27 dias. Agora drena em loop
  // até esvaziar ou estourar o orçamento de tempo do edge (com folga do 60s).
  const RUN_BUDGET_MS = 45_000;
  const summary = { lidos: 0, lotes: 0, sugeridos: 0, sem_candidato: 0, duration_ms: 0, erros: [] as string[] };
  while (Date.now() - startedAt < RUN_BUDGET_MS) {
  const { data: msgs, error: readErr } = await supabase.rpc("read_from_pgmq", {
    queue_name: "scan_email_pre_card",
    vt_seconds: VT_SECONDS,
    qty: BATCH_SIZE,
  });
  if (readErr) {
    if (summary.lotes === 0) return jsonResp({ ok: false, error: `read_from_pgmq: ${readErr.message}` }, 500);
    summary.erros.push(`read_from_pgmq: ${readErr.message}`);
    break;
  }

  const queue = (msgs ?? []) as QueueRow[];
  if (queue.length === 0) break;
  summary.lotes++;
  summary.lidos += queue.length;

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
    .select(
      "id, nf, created_at, assigned_operator_id, agent_state, pagador, state, tratativa_email_escolhida, email_preexistente_sugerido",
    )
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
      state: string | null;
      tratativa_email_escolhida: string | null;
      email_preexistente_sugerido: { decidido_em?: string | null } | null;
    }
    | null;
  if (!card) return { resultado: "card_inexistente", candidatos_total: 0 };

  // Guards de idempotência (auditoria 25/07 — loop VIVO NF 2549: a MESMA
  // mensagem re-importada 44x num card TRANSFERIDO com tratativa já escolhida;
  // cada e-mail novo clobberava o sinal DECIDIDO e re-enfileirava adoção).
  if (card.state === "TRANSFERIDO" || card.state === "RESOLVIDO" || card.state === "CANCELADO") {
    await registrarLog(supabase, cardId, {
      nf: card.nf, operador_id: card.assigned_operator_id, candidatos_total: 0, resultado: "card_terminal",
    });
    return { resultado: "card_terminal", candidatos_total: 0 };
  }
  if (card.email_preexistente_sugerido?.decidido_em != null || card.tratativa_email_escolhida != null) {
    await registrarLog(supabase, cardId, {
      nf: card.nf, operador_id: card.assigned_operator_id, candidatos_total: 0, resultado: "ja_decidido",
    });
    return { resultado: "ja_decidido", candidatos_total: 0 };
  }

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

  // Caio 2026-06-23: card_em_espera = thread do cliente (com retorno) detectada
  // por e-mail novo → AUTO-ADOTA como PRINCIPAL (puxa + interpreta + tratativa
  // principal + CLIENTE RESPONDEU). A thread do cliente vira a oficial; o
  // Cockpit responde NELA (menos e-mail). Operador revisa/descarta se errou.
  // 'nascimento' NÃO auto-adota (segue como banner, operador escolhe).
  if ((msg.contexto ?? "nascimento") === "card_em_espera") {
    await supabase.rpc("enqueue_to_pgmq", {
      queue_name: "importar_thread_adotada",
      payload: {
        card_id: cardId,
        gmail_thread_id: melhor.cand.gmail_thread_id,
        operador_id: operadorId,
        auto: true,
      },
    });
  }

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
): Promise<"adotado" | "pulado"> {
  const cardId = msg.card_id;
  const threadId = msg.gmail_thread_id;
  if (!cardId || !threadId) return "pulado";

  const { data: cardRow } = await supabase
    .from("cards")
    .select("id, assigned_operator_id, state, tratativa_email_escolhida")
    .eq("id", cardId)
    .maybeSingle();
  const card = cardRow as {
    id: string;
    assigned_operator_id: string | null;
    state: string | null;
    tratativa_email_escolhida: string | null;
  } | null;

  // TRAVA DE IDEMPOTÊNCIA (incidente 26/07): sem ela, cada job repetido
  // re-importava a thread inteira do Gmail, movia o card e recriava propostas
  // (NF 166229: 105x num dia). Ver _shared/adocao-thread.ts.
  const decisao = decidirAdocaoThread(card, threadId);
  if (decisao.acao === "pular") {
    console.log(`[adocao] pulado card=${cardId} thread=${threadId}: ${decisao.motivo}`);
    return "pulado";
  }
  if (!card) return "pulado";

  // REGRA INVIOLÁVEL (Caio 2026-06-23): o card só vai pra CLIENTE RESPONDEU se JÁ
  // houve notificação NOSSA antes (cliente respondeu / abriu thread pós-notificação).
  // Se o Cockpit/operador NUNCA notificou (cliente cobrou ANTES da notificação),
  // fica em AGUARDANDO VOCÊ — o operador ainda precisa notificar o extravio.
  const { data: preOut } = await supabase
    .from("cards_emails_outbound").select("id").eq("card_id", cardId).limit(1);
  let tinhaNotificacao = ((preOut as unknown[] | null)?.length ?? 0) > 0;

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

  // Envio manual do operador na thread também conta como notificação.
  tinhaNotificacao = tinhaNotificacao || outbound > 0;

  // ROTEAMENTO — regra inviolável (Caio 2026-06-23):
  let notaAgente: string | null = null;
  let roteamento: "cliente_respondeu" | "aguardando_voce" = "aguardando_voce";
  if (latestInbound && tinhaNotificacao) {
    // JÁ houve notificação nossa → o cliente RESPONDEU/seguiu → CLIENTE RESPONDEU
    // (igual ao vinculador; INV-006: oc=54 exceção quando cliente_respondeu != null).
    roteamento = "cliente_respondeu";
    const { data: stRow } = await supabase.from("cards").select("state").eq("id", cardId).maybeSingle();
    const estadoAtual = (stRow as { state?: string } | null)?.state;
    const upd: Record<string, unknown> = { cliente_respondeu_em: new Date().toISOString() };
    if (estadoAtual === "AGUARDANDO_CLIENTE") {
      upd.state = "AGUARDANDO_VALIDACAO_HUMANA";
      upd.lock_aguardando_validacao = true;
    }
    await supabase.from("cards").update(upd).eq("id", cardId);
    try {
      await supabase.rpc("cancelar_acoes_agendadas_do_card", {
        p_card_id: cardId,
        p_motivo: "cliente respondeu em thread adotada (scan-email-pre-card)",
      });
    } catch (_e) { /* best-effort */ }
    // Caio 2026-06-23 (NF 761583, INV-016): cria as propostas pós-resposta
    // cliente AQUI, de forma DETERMINÍSTICA (sem LLM). Antes a criação de
    // propostas dependia 100% do re-enqueue→triador→vinculador abaixo; quando a
    // Anthropic 529 derrubou o triador, a mensagem foi pro DLQ, o vinculador
    // nunca rodou e o card ficou em CLIENTE RESPONDEU com ZERO botões. Idempotente
    // — se o vinculador rodar depois (re-enqueue) não duplica. O operador SEMPRE
    // tem as ações; o re-enqueue/cron só preenche a sugestão da IA (ia_sugestao).
    try {
      const propostas = await atualizarPropostasAposRespostaCliente(supabase, cardId);
      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "PropostasPosRespostaCriadas",
        actor_type: "system",
        actor_id: "scan-email-pre-card",
        payload: { origem: "thread_adotada", criados: propostas.criados, ja_existentes: propostas.ja_existentes },
      });
    } catch (e) {
      console.log(`[scan-email-pre-card] criar propostas pós-resposta falhou: ${e instanceof Error ? e.message : e}`);
    }
    // Interpretação ASSÍNCRONA via pipeline normal (agent_intake → vinculador →
    // interpretador) — só pra preencher ia_sugestao_oc_resposta. As propostas
    // (botões) já foram criadas acima; isto NÃO está mais no caminho crítico.
    try {
      await supabase.from("messages_inbox").update({ processing_status: "pending" }).eq("id", latestInbound.id);
      await supabase.rpc("enqueue_to_pgmq", {
        queue_name: "agent_intake",
        payload: { message_id: latestInbound.id, canal: "email", recebido_em: new Date(latestInbound.ts || Date.now()).toISOString() },
      });
    } catch (e) {
      console.log(`[scan-email-pre-card] enqueue agent_intake pós-adoção falhou: ${e instanceof Error ? e.message : e}`);
    }
  } else if (latestInbound && !tinhaNotificacao) {
    // NUNCA notificamos → o cliente COBROU ANTES da notificação. Fica em
    // AGUARDANDO VOCÊ (NÃO seta cliente_respondeu, NÃO muda state) — o operador
    // ainda precisa notificar o extravio. O agente deixa a nota de contexto + a
    // sugestão; as propostas de notificação (oc 54 etc.) já existem no card.
    roteamento = "aguardando_voce";
    notaAgente =
      "📨 O cliente ABRIU a conversa cobrando esta NF ANTES de qualquer notificação nossa (ele não respondeu " +
      "ninguém — criou o e-mail). Puxei o histórico da thread dele e ela já é a principal. O extravio causou o " +
      "atraso e ainda precisamos dar o retorno ao cliente: o card SEGUE em AGUARDANDO VOCÊ. Sugiro NOTIFICAR o " +
      "extravio (oc 54 + e-mail, template de extravio) NESTA thread, pra não criar e-mail paralelo.";
    // Traz de volta o banner ACIONÁVEL do agente. NÃO é "cliente respondeu
    // inconclusivo" (default do front pra oc 54): aqui o cliente CRIOU a conversa
    // e nós ainda não notificamos → a ação é NOTIFICAR O EXTRAVIO (oc 54 + e-mail,
    // template de extravio). A proposta `lancar_oc_e_enviar_email` (codigo_ssw 54,
    // template FALTA_DE_VOLUME = extravio) já existe nos todos; isto só destaca/aciona
    // com o título correto pro front não cair no label de "resposta do cliente".
    await supabase.from("cards").update({
      ia_sugestao_oc_resposta: {
        oc_sugerida: 54,
        confianca: 0.9,
        motivo: notaAgente,
        sugerido_em: new Date().toISOString(),
        message_id: latestInbound.id,
        contexto: "cobrou_antes_notificacao",
        // Título/ação explícitos: o front DEVE usar isto e ignorar o label default
        // de oc 54 ("re-lançar / cliente respondeu inconclusivo").
        titulo: "Notificar o extravio ao cliente — lançar oc 54 + e-mail",
        acao_tool: "lancar_oc_e_enviar_email",
        acao_codigo_ssw: 54,
      },
    }).eq("id", cardId);
  }

  // Adoção AUTOMÁTICA (card_em_espera): marca a sugestão como confirmada e a
  // thread escolhida como PRINCIPAL (já é a tratativa_email_escolhida via mig 212).
  // Tira o badge "pendente"; o front mostra "THREAD PRINCIPAL" + opção de descartar.
  if (msg.auto) {
    const { data: cur } = await supabase
      .from("cards").select("email_preexistente_sugerido").eq("id", cardId).maybeSingle();
    const sug = ((cur as { email_preexistente_sugerido?: Record<string, unknown> } | null)
      ?.email_preexistente_sugerido) ?? {};
    await supabase.from("cards").update({
      email_preexistente_sugerido: {
        ...sug,
        decisao: "seguir",
        decidido_em: new Date().toISOString(),
        thread_principal: threadId,
        auto: true,
        // 'cliente_respondeu' (foi pra CLIENTE RESPONDEU) | 'aguardando_voce'
        // (cliente cobrou antes da notificação — segue em AGUARDANDO VOCÊ).
        roteamento,
        nota_agente: notaAgente,
      },
    }).eq("id", cardId);
  }

  return "adotado";
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
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
