// =============================================================================
// triador — consome pgmq.agent_intake, classifica mensagem com Sonnet 4.6,
// grava ClassificacaoConcluida em card_events, enfileira em agent_specialist.
//
// Disparada por:
//   1. pg_cron a cada 1min (pra processar fila acumulada)
//   2. invocação HTTP direta (debug)
//
// Idempotência: cada msg da fila tem msg_id; lemos com vt=120s (worker
// pessimista). Em sucesso → delete. Em erro → deixa expirar pra retry.
//   Após N tentativas (read_ct >= 3) → archive_to_dead_letter.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  type AnthropicUsageRecord,
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";
import { makeUsageRecorder } from "../_shared/anthropic-usage-logger.ts";
import { invokeNext } from "../_shared/invoke-next.ts";
import {
  TRIADOR_MODEL,
  TRIADOR_SYSTEM_PROMPT,
  TRIADOR_VERSION,
} from "../_shared/prompts/triador.ts";

const VT_SECONDS = 120;
const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 3;

interface QueueMessage {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: {
    message_id: string;
    canal: "whatsapp" | "email" | "sistema";
    remetente: string;
    recebido_em: string;
  };
}

interface TriadorOutput {
  tipo:
    | "rastreamento"
    | "reentrega"
    | "devolucao"
    | "avaria"
    | "extravio"
    | "inversao"
    | "cobranca"
    | "outros";
  risco: "alto" | "baixo";
  resumo: string;
  descricao_problema: string;
  nfs: string[];
  ctrcs: string[];
  nome_cliente: string | null;
  empresa_cliente: string | null;
  requer_acompanhamento: boolean;
  cliente_autorizou_reentrega: boolean;
}

interface RunSummary {
  read: number;
  classified: number;
  enqueued: number;
  archived: number;
  errors: Array<{ msg_id: number | null; message_id?: string; message: string }>;
  duration_ms: number;
}

serve(async (req) => {
  const startedAt = Date.now();

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const anthropic = createAnthropicClient({
      env: readAnthropicEnvFromProcess(env),
      onUsage: makeUsageRecorder(supabase, { functionName: "triador", agentName: "triador" }),
    });

    const { data: msgs, error: readErr } = await supabase.rpc("read_from_pgmq", {
      queue_name: "agent_intake",
      vt_seconds: VT_SECONDS,
      qty: BATCH_SIZE,
    });

    if (readErr) {
      throw new Error(`read_from_pgmq: ${readErr.message}`);
    }

    const queue = (msgs ?? []) as QueueMessage[];
    const summary: RunSummary = {
      read: queue.length,
      classified: 0,
      enqueued: 0,
      archived: 0,
      errors: [],
      duration_ms: 0,
    };

    for (const job of queue) {
      try {
        await processOne(supabase, anthropic, job, summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.errors.push({ msg_id: job.msg_id, message_id: job.message?.message_id, message: msg });

        if (job.read_ct >= MAX_ATTEMPTS) {
          // Move pra dead_letter pra inspeção manual
          await supabase.rpc("archive_to_dead_letter", {
            source_queue: "agent_intake",
            source_msg_id: job.msg_id,
            motivo: `triador: ${msg.slice(0, 200)} (após ${job.read_ct} tentativas)`,
            original_payload: job.message,
          });
          summary.archived++;
        }
        // Senão, deixa o vt expirar e reentra na fila pra retry
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    console.log("triador done:", JSON.stringify(summary));

    // Acorda vinculador na hora se classificamos pelo menos 1 mensagem.
    // 1 invoke cobre o batch inteiro — vinculador faz seu próprio read_from_pgmq
    // e processa N mensagens por vez. Se invoke falhar, cron de 1min é fallback.
    if (summary.enqueued > 0) {
      invokeNext({
        functionName: "vinculador",
        supabaseUrl: env["SUPABASE_URL"]!,
        serviceRoleKey: env["SUPABASE_SERVICE_ROLE_KEY"]!,
      });
    }

    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("triador fatal:", msg);
    return new Response(
      JSON.stringify({ error: msg, duration_ms: Date.now() - startedAt }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

// =============================================================================

type SupabaseClient = ReturnType<typeof createClient>;
type AnthropicClient = ReturnType<typeof createAnthropicClient>;

async function processOne(
  supabase: SupabaseClient,
  anthropic: AnthropicClient,
  job: QueueMessage,
  summary: RunSummary,
): Promise<void> {
  const messageId = job.message.message_id;

  // 1. Pega messages_inbox row
  const { data: inboxRow, error: selErr } = await supabase
    .from("messages_inbox")
    .select("id, canal, remetente, conteudo, recebido_em, processing_status")
    .eq("id", messageId)
    .maybeSingle();

  if (selErr) throw new Error(`SELECT messages_inbox: ${selErr.message}`);
  if (!inboxRow) throw new Error(`messages_inbox.id=${messageId} não encontrado`);

  // Idempotência: se já processada, só remove da fila
  if (inboxRow.processing_status === "processed") {
    await supabase.rpc("delete_from_pgmq", {
      queue_name: "agent_intake",
      msg_id: job.msg_id,
    });
    return;
  }

  // 2. Histórico 24h do mesmo remetente (contexto pro triador)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: historico } = await supabase
    .from("messages_inbox")
    .select("conteudo, recebido_em")
    .eq("remetente", inboxRow.remetente)
    .gte("recebido_em", dayAgo)
    .lt("recebido_em", inboxRow.recebido_em)
    .order("recebido_em", { ascending: true })
    .limit(20);

  const historicoTxt = (historico ?? [])
    .map((h) => `[${h.recebido_em}] ${String(h.conteudo).slice(0, 500)}`)
    .join("\n");

  // Mensagem atual ANTES do histórico — bias visual ajuda o modelo a focar
  // entidades na mensagem, e o histórico fica claro como contexto. Combinado
  // com a regra do prompt ("nfs/ctrcs só da Mensagem atual"), reduz vazamento
  // de NFs antigas que confundiam o vinculador (vinha card de teste antigo).
  const userPrompt = [
    `Canal: ${inboxRow.canal}`,
    `Remetente: ${inboxRow.remetente}`,
    `Mensagem atual:\n"""\n${inboxRow.conteudo}\n"""`,
    historicoTxt
      ? `\nHistórico nas últimas 24h (somente contexto — NÃO extraia NFs/CTRCs daqui):\n${historicoTxt}`
      : "",
  ].filter(Boolean).join("\n");

  // 3. Chama Anthropic com prompt do triador
  const usageRecs: AnthropicUsageRecord[] = [];
  const classification = await anthropic.completeJson<TriadorOutput>({
    model: TRIADOR_MODEL,
    system: TRIADOR_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 800,
    temperature: 0.1,
    meta: { messageId, usageSink: usageRecs },
  });

  // Defesa em código: filtra NFs/CTRCs que NÃO aparecem na mensagem atual.
  // Se o modelo escorregar e puxar NF do histórico, a gente corta antes de
  // chegar no vinculador. Fallback caso o prompt falhe.
  classification.nfs = filterEntitiesPresentInText(classification.nfs ?? [], inboxRow.conteudo);
  classification.ctrcs = filterEntitiesPresentInText(classification.ctrcs ?? [], inboxRow.conteudo);

  // Regex fallback: se modelo devolveu nfs=[] mas a mensagem tem números 4-9
  // dígitos, extrai automaticamente. Cobre o caso comum de cliente escrevendo
  // "[insucesso 894667]" ou "carga 154848 não chegou" sem o rótulo "nf".
  // Falso positivo é tolerável — vinculador descarta NFs que não batem em
  // Bastão/SSW. Falso negativo (sem NF) cria card incompleto, ruim.
  if (classification.nfs.length === 0) {
    const candidates = extractNfCandidatesByRegex(inboxRow.conteudo);
    if (candidates.length > 0) {
      classification.nfs = candidates;
      console.log(`triador regex-fallback extraiu ${candidates.length} NF(s):`, candidates);
    }
  }

  summary.classified++;

  // 4. agent_runs (telemetria) — soma tokens dos attempts. Fonte PRIMÁRIA de
  //    custo é anthropic_usage_log (via onUsage); aqui é secundário/best-effort.
  const tokIn = usageRecs.reduce((a, r) => a + r.inputTokens, 0);
  const tokOut = usageRecs.reduce((a, r) => a + r.outputTokens, 0);
  await supabase.from("agent_runs").insert({
    agent_name: "triador",
    step_name: `version=${TRIADOR_VERSION}`,
    input: { message_id: messageId, canal: inboxRow.canal, remetente: inboxRow.remetente },
    output: classification,
    model: TRIADOR_MODEL,
    tokens_in: tokIn || null,
    tokens_out: tokOut || null,
    status: "success",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });

  // 5. messages_inbox.processing_status = 'processed'
  await supabase
    .from("messages_inbox")
    .update({
      processing_status: "processed",
      processed_at: new Date().toISOString(),
    })
    .eq("id", messageId);

  // 6. Enfileira em agent_specialist pra vinculador processar depois
  const { error: enqErr } = await supabase.rpc("enqueue_to_pgmq", {
    queue_name: "agent_specialist",
    payload: {
      message_id: messageId,
      classification,
      canal: inboxRow.canal,
      remetente: inboxRow.remetente,
      conteudo: inboxRow.conteudo,
      recebido_em: inboxRow.recebido_em,
    },
  });

  if (enqErr) {
    // Mensagem já foi classificada e o status mudou. Loga, mas não throw —
    // próximo tick do triador vai re-tentar enfileirar via re-leitura?
    // Não, vai ver processing_status='processed' e pular.
    // Solução: enfileira manualmente via dead_letter pra inspeção.
    console.warn(`Enqueue agent_specialist falhou (msg ${messageId}): ${enqErr.message}`);
    throw new Error(`enqueue agent_specialist: ${enqErr.message}`);
  }

  summary.enqueued++;

  // 7. Confirma processamento (delete da fila)
  await supabase.rpc("delete_from_pgmq", {
    queue_name: "agent_intake",
    msg_id: job.msg_id,
  });
}

// =============================================================================
// Filtro de entidades — descarta valores que não aparecem na mensagem atual.
//
// Compara dígitos contra dígitos: tira pontuação/espaço/zeros à esquerda dos
// dois lados, garante que a sequência de dígitos do candidato aparece dentro
// dos dígitos da mensagem. Tolerante a formatações ("232.323", "232 323",
// "0232323", "nf nº 232323"). Pra CTRCs com letras, mantém também checagem
// case-insensitive textual.
// =============================================================================

function filterEntitiesPresentInText(values: string[], text: string): string[] {
  if (!values || values.length === 0) return [];
  const textDigits = text.replace(/\D/g, "");
  const textLower = text.toLowerCase();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string" || !v) continue;
    const vDigits = v.replace(/\D/g, "").replace(/^0+/, "");
    const hasDigitMatch = vDigits.length > 0 && textDigits.includes(vDigits);
    const hasTextMatch = textLower.includes(v.toLowerCase());
    if (hasDigitMatch || hasTextMatch) {
      out.push(v);
    }
  }
  return out;
}

// =============================================================================
// Regex fallback pra extrair NFs quando o modelo devolve []. Procura sequências
// de 4-9 dígitos isoladas (não dentro de strings maiores tipo CNPJ 14, telefone
// 11, datas DD/MM/AAAA, valores monetários R$ X,XX).
//
// Estratégia:
//   1. Strip de e-mails, URLs, datas (formatos comuns), CNPJs/CPFs com máscara,
//      telefones brasileiros — todos viram espaço
//   2. Captura \b\d{4,9}\b no que sobrou
//   3. Dedup, strip leading zeros, descarta candidatos suspeitos
// =============================================================================

function extractNfCandidatesByRegex(text: string): string[] {
  if (!text) return [];

  let cleaned = text
    // emails inteiros
    .replace(/\S+@\S+\.\S+/g, " ")
    // URLs
    .replace(/https?:\/\/\S+/gi, " ")
    // datas DD/MM/AAAA, DD-MM-AAAA, AAAA-MM-DD
    .replace(/\b\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4}\b/g, " ")
    // hora HH:MM ou HH:MM:SS
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    // CNPJ formatado XX.XXX.XXX/XXXX-XX
    .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, " ")
    // CPF formatado XXX.XXX.XXX-XX
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, " ")
    // valores monetários R$ X.XXX,XX
    .replace(/R\$\s*[\d.,]+/gi, " ")
    // telefone brasileiro com DDD: (XX) XXXXX-XXXX, +55 XX XXXXX-XXXX
    .replace(/\(?\+?55\)?\s*\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}/g, " ")
    .replace(/\(\d{2}\)\s*9?\d{4}[-\s]?\d{4}/g, " ");

  const found = new Set<string>();
  const matches = cleaned.matchAll(/\b(\d{4,9})\b/g);
  for (const m of matches) {
    const raw = m[1]!;
    // Strip leading zeros
    const normalized = raw.replace(/^0+/, "") || raw;
    // Descarta sequências de zeros puros e candidatos absurdos
    if (normalized.length < 4) continue;
    if (/^0+$/.test(raw)) continue;
    found.add(normalized);
  }

  return Array.from(found);
}
