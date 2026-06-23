// =============================================================================
// reprocessar-dlq — auto-cura de mensagens presas no dead_letter (DLQ).
//
// Caio 2026-06-23 (NF 761583, INV-016): a Anthropic estourou 529 (Overloaded)
// entre 14:18–14:57 UTC. O triador (classifica TODA mensagem via LLM) falhou 3x
// e jogou 13 mensagens de clientes no dead_letter. Não havia NENHUM
// reprocessamento — um 529 transitório encalhava a resposta do cliente PRA
// SEMPRE. Cards em AGUARDANDO_CLIENTE cujos clientes responderam nem apareciam
// como "CLIENTE RESPONDEU". Regra inviolável violada.
//
// Este cron (2min) drena o DLQ de volta pras filas de origem:
//   - source_queue = agent_intake     → re-enfileira (triador re-classifica)
//   - source_queue = agent_specialist → re-enfileira (vinculador re-processa)
// Outras origens (agent_executor) NÃO são tocadas (remediação diferente).
//
// Backoff: cada re-enfileiramento incrementa `_reprocess_attempt` DENTRO do
// payload. O triador arquiva `original_payload: job.message`, então o contador
// SOBREVIVE ao round-trip pelo DLQ. Acima de MAX_REPROCESS a mensagem fica
// PARADA no DLQ (não re-tenta) — aí o health-check alerta o Caio. Evita
// amplificar carga numa Anthropic já sobrecarregada.
//
// Idempotente: re-enfileirar é seguro (vinculador/triador são idempotentes).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const REPROCESSAVEIS = new Set(["agent_intake", "agent_specialist"]);
const MAX_REPROCESS = 4;          // cap de re-tentativas por mensagem
const READ_QTY = 100;             // lê até 100 do DLQ por run
const READ_VT_SECONDS = 25;       // janela de invisibilidade durante o processamento
// Só reprocessa falhas RECENTES (outage transitório). Mensagens muito antigas
// (ex: falha do vinculador semanas atrás) NÃO são ressuscitadas — viram dado
// stale (NF já resolvida, card já fechado). Ficam no DLQ pra inspeção manual.
const MAX_IDADE_REPROCESS_MS = 60 * 60 * 1000; // 60min

interface DlqMessage {
  msg_id: number;
  read_ct: number;
  message: {
    source_queue?: string;
    source_msg_id?: number;
    motivo?: string;
    archived_at?: string;
    original_payload?: Record<string, unknown> & { message_id?: string; _reprocess_attempt?: number };
  };
}

Deno.serve(async (_req) => {
  const startedAt = Date.now();
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);

  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: lidas, error: readErr } = await supabase.rpc("read_from_pgmq", {
    queue_name: "dead_letter",
    vt_seconds: READ_VT_SECONDS,
    qty: READ_QTY,
  });
  if (readErr) return json({ ok: false, error: `read dead_letter: ${readErr.message}` }, 500);

  const msgs = (lidas ?? []) as DlqMessage[];
  const summary = { lidas: msgs.length, reenfileiradas: 0, travadas: 0, ignoradas: 0, erros: 0 as number };
  const reenfileiradasDetalhe: Array<{ source_queue: string; message_id?: string; attempt: number }> = [];
  const travadasDetalhe: Array<{ msg_id: number; source_queue: string; message_id?: string }> = [];

  for (const m of msgs) {
    const sourceQueue = m.message?.source_queue;
    if (!sourceQueue || !REPROCESSAVEIS.has(sourceQueue)) {
      // Outra origem (ex: agent_executor) — não mexe; reaparece após o vt.
      summary.ignoradas++;
      continue;
    }
    const original = m.message?.original_payload ?? {};
    const attempt = Number(original._reprocess_attempt ?? 0);
    const messageId = original.message_id;

    // Guard de idade: não ressuscita falha antiga (NF já resolvida há semanas).
    const archivedMs = m.message?.archived_at ? Date.parse(m.message.archived_at) : NaN;
    if (!Number.isNaN(archivedMs) && (Date.now() - archivedMs) > MAX_IDADE_REPROCESS_MS) {
      summary.ignoradas++;
      continue;
    }

    if (attempt >= MAX_REPROCESS) {
      // Esgotou as tentativas — fica no DLQ pra inspeção. health-check alerta.
      summary.travadas++;
      travadasDetalhe.push({ msg_id: m.msg_id, source_queue: sourceQueue, message_id: messageId });
      continue;
    }

    try {
      // O triador pula messages_inbox com processing_status='processed'. Reabre.
      if (messageId) {
        await supabase.from("messages_inbox")
          .update({ processing_status: "pending" })
          .eq("id", messageId)
          .neq("processing_status", "pending");
      }
      const novoPayload = { ...original, _reprocess_attempt: attempt + 1, _reprocessado_em: new Date().toISOString() };
      const { error: enqErr } = await supabase.rpc("enqueue_to_pgmq", {
        queue_name: sourceQueue,
        payload: novoPayload,
      });
      if (enqErr) throw new Error(`enqueue ${sourceQueue}: ${enqErr.message}`);

      const { error: delErr } = await supabase.rpc("delete_from_pgmq", {
        queue_name: "dead_letter",
        msg_id: m.msg_id,
      });
      if (delErr) throw new Error(`delete dead_letter: ${delErr.message}`);

      summary.reenfileiradas++;
      reenfileiradasDetalhe.push({ source_queue: sourceQueue, message_id: messageId, attempt: attempt + 1 });
    } catch (e) {
      summary.erros++;
      console.error(`[reprocessar-dlq] msg ${m.msg_id} falhou: ${e instanceof Error ? e.message : e}`);
      // não deleta → reaparece após o vt e tenta de novo no próximo ciclo
    }
  }

  console.log("reprocessar-dlq:", JSON.stringify({ ...summary, reenfileiradasDetalhe, travadasDetalhe }));
  return json({ ok: true, ...summary, reenfileiradasDetalhe, travadasDetalhe, duration_ms: Date.now() - startedAt }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
