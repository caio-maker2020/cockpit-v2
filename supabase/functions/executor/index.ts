// =============================================================================
// executor — consome pgmq.agent_executor, chama SSW pra lançar ocorrência,
// grava audit_log + card_event AcaoExecutada, marca todo.status='executando'.
//
// TEST_FILTER: Durante a fase de teste, executor SÓ processa cards atribuídos
// a operadores na lista (env EXECUTOR_TEST_OPERATORS). Em produção, deixar
// vazio pra liberar todos. Garantia extra contra disparo acidental no SSW
// de produção.
//
// Idempotency: lib/ssw-client deriva chave SHA256(card_id, codigo, nf).
// audit_log.idempotency_key é UNIQUE — mesmo se executor for chamado 2x
// (network retry, cron race), apenas 1 INSERT vence; outros falham com
// duplicate key e a gente reusa o resultado.
//
// Fluxo:
//   1. Lê msg da fila com vt=180s (ações SSW podem demorar)
//   2. Pega card + agent_state (pra pegar cnpj_remetente quando não vem no payload)
//   3. Aplica TEST_FILTER
//   4. Chama lib/ssw-client.lancarOcorrencia()
//   5. Grava audit_log (success/failed)
//   6. Grava card_event AcaoExecutada
//   7. UPDATE todo.status='executando' — Pass C do sync-bastao confirma depois
//   8. Confirma processamento (delete_from_pgmq)
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createSswClient, readSswEnvFromProcess } from "../_shared/ssw-client.ts";

const VT_SECONDS = 180;
const BATCH_SIZE = 3;
const MAX_ATTEMPTS = 3;

interface QueueMessage {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: {
    todo_id: string;
    card_id: string;
    action_id: string;
    proposta_payload: {
      tool: string;
      args: {
        // codigo_ssw é o que o operador conhece (= aparece no painel SSW).
        // Executor traduz pra codigo_api via lookup_codigo_api antes de chamar SSW.
        codigo_ssw?: number | string;
        // Compat retro: payloads antigos podem ter "codigo" — tratado como codigo_ssw.
        codigo?: number | string;
        chave_cte?: string;
        nf?: string;
        cnpj_remetente?: string | null;
        descricao?: string;
      };
      rationale?: string;
      texto?: string | null;
    };
    aprovado_por: string;
    card_nf?: string;
    card_ctrc?: string;
  };
}

interface RunSummary {
  read: number;
  executed: number;
  filtered_out: number;
  failed: number;
  archived: number;
  errors: Array<{ msg_id: number | null; todo_id?: string; message: string }>;
  duration_ms: number;
}

serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const ssw = createSswClient({ env: readSswEnvFromProcess(env) });

    const testOperatorsRaw = env["EXECUTOR_TEST_OPERATORS"] ?? "";
    const testOperators = testOperatorsRaw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const filterEnabled = testOperators.length > 0;

    const { data: msgs, error: readErr } = await supabase.rpc("read_from_pgmq", {
      queue_name: "agent_executor",
      vt_seconds: VT_SECONDS,
      qty: BATCH_SIZE,
    });

    if (readErr) throw new Error(`read_from_pgmq: ${readErr.message}`);

    const queue = (msgs ?? []) as QueueMessage[];
    const summary: RunSummary = {
      read: queue.length,
      executed: 0,
      filtered_out: 0,
      failed: 0,
      archived: 0,
      errors: [],
      duration_ms: 0,
    };

    for (const job of queue) {
      try {
        await processOne(supabase, ssw, job, testOperators, filterEnabled, summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.errors.push({ msg_id: job.msg_id, todo_id: job.message?.todo_id, message: msg });
        if (job.read_ct >= MAX_ATTEMPTS) {
          await supabase.rpc("archive_to_dead_letter", {
            source_queue: "agent_executor",
            source_msg_id: job.msg_id,
            motivo: `executor: ${msg.slice(0, 200)} (após ${job.read_ct} tentativas)`,
            original_payload: job.message,
          });
          summary.archived++;
        }
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    console.log("executor done:", JSON.stringify(summary));

    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("executor fatal:", msg);
    return new Response(JSON.stringify({ error: msg, duration_ms: Date.now() - startedAt }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// =============================================================================

type SupabaseClient = ReturnType<typeof createClient>;
type SswClient = ReturnType<typeof createSswClient>;

async function processOne(
  supabase: SupabaseClient,
  ssw: SswClient,
  job: QueueMessage,
  testOperators: string[],
  filterEnabled: boolean,
  summary: RunSummary,
): Promise<void> {
  const m = job.message;

  // 1. Pega card pra TEST_FILTER + cnpj_remetente fallback
  const { data: card, error: cardErr } = await supabase
    .from("cards")
    .select(`
      id,
      nf,
      ctrc,
      assigned_operator_id,
      agent_state,
      operadores!cards_assigned_operator_id_fkey(nome)
    `)
    .eq("id", m.card_id)
    .single();

  if (cardErr) throw new Error(`SELECT card: ${cardErr.message}`);
  if (!card) throw new Error(`Card ${m.card_id} não encontrado`);

  // 2. TEST_FILTER
  if (filterEnabled) {
    const opData = (card as Record<string, unknown>)["operadores"] as
      | { nome: string }
      | { nome: string }[]
      | null;
    const opNome = (Array.isArray(opData) ? opData[0]?.nome : opData?.nome) ?? "";
    if (!testOperators.includes(opNome.toUpperCase())) {
      // Filtrado — log e descarta da fila pra não acumular
      console.warn(
        `executor TEST_FILTER bloqueou todo=${m.todo_id} card=${m.card_id} ` +
          `operador="${opNome}" não está em [${testOperators.join(",")}]`,
      );
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "AcaoExecutadaBloqueadaPorTestFilter",
        actor_type: "system",
        actor_id: "executor",
        payload: { todo_id: m.todo_id, motivo: "test_filter", operador: opNome },
      });
      await supabase.rpc("delete_from_pgmq", { queue_name: "agent_executor", msg_id: job.msg_id });
      summary.filtered_out++;
      return;
    }
  }

  // 3. Resolve cnpj_remetente: payload.args primeiro, fallback agent_state
  const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
  const cnpjRemetente =
    m.proposta_payload.args.cnpj_remetente ??
    (agentState["cnpj_remetente"] as string | null | undefined) ??
    null;

  // chave CT-e fiscal (44 dígitos): payload primeiro, fallback agent_state
  const chaveCTe =
    m.proposta_payload.args.chave_cte ??
    (agentState["chave_cte"] as string | null | undefined) ??
    null;

  const nf = m.proposta_payload.args.nf ?? card.nf ?? null;

  // Resolve codigo_ssw: prefere args.codigo_ssw; fallback args.codigo (compat retro).
  const codigoSswRaw = m.proposta_payload.args.codigo_ssw ?? m.proposta_payload.args.codigo;
  const codigoSsw =
    typeof codigoSswRaw === "number"
      ? codigoSswRaw
      : codigoSswRaw != null
        ? parseInt(String(codigoSswRaw), 10)
        : NaN;

  if (!chaveCTe) {
    throw new Error(
      `chave_cte não disponível pro todo ${m.todo_id} — necessário pra lançar ocorrência`,
    );
  }
  if (!Number.isFinite(codigoSsw)) {
    throw new Error(`codigo_ssw de ocorrência não fornecido no proposta_payload`);
  }

  // Traduz codigo_ssw → codigo_api via tabela ocorrencias_dexpara (migration 019).
  // Operador/agente trabalham na linguagem do SSW (oc 21 = reentrega); a API
  // do SSW exige outro número (29) por causa do de-para interno.
  const { data: codigoApiResult, error: lookupErr } = await supabase.rpc(
    "lookup_codigo_api",
    { p_codigo_ssw: codigoSsw },
  );
  if (lookupErr) {
    throw new Error(`lookup_codigo_api falhou: ${lookupErr.message}`);
  }
  const codigoApi = codigoApiResult as number | null;
  if (codigoApi == null) {
    throw new Error(
      `Sem mapeamento de-para pra codigo_ssw=${codigoSsw}. ` +
        `Adicione em ocorrencias_dexpara antes de aprovar este todo.`,
    );
  }

  const descricao =
    m.proposta_payload.args.descricao ?? `Ocorrência ${codigoSsw} lançada via Cockpit`;

  // SSW tracking público não retorna cnpj_remetente — quando vier do SSW
  // tracking, manda string vazia. SSW aceita vazio quando chaveCTe identifica.
  const cnpjRemetenteParaSsw = cnpjRemetente ?? "";

  // 4. Chama SSW (schema cte.chaveCTe — não numeroNFe/serieNFe).
  // codigo enviado pra API é o codigo_api (29), que vira oc 21 no painel SSW.
  // todoId no idempotency permite múltiplos lançamentos da mesma oc na mesma NF
  // (1 por to-do aprovado — cliente pode cobrar reentrega novamente).
  const sswResult = await ssw.lancarOcorrencia({
    cardId: m.card_id,
    todoId: m.todo_id,
    cnpjRemetente: cnpjRemetenteParaSsw,
    chaveCTe,
    codigo: String(codigoApi),
    descricao,
  });

  // 5. audit_log
  const auditPayload: Record<string, unknown> = {
    card_id: m.card_id,
    action_type: "lancar_ocorrencia",
    actor_type: "agent",
    actor_id: "executor",
    external_system: "ssw",
    idempotency_key: sswResult.idempotencyKey,
    request_payload: {
      cnpj_remetente: cnpjRemetente,
      chave_cte: chaveCTe,
      nf,
      codigo_ssw: codigoSsw,
      codigo_api: codigoApi,
      descricao,
    },
    response_payload: sswResult.raw,
    status: sswResult.ok ? "success" : "failed",
    external_id: sswResult.ok ? sswResult.protocolo : null,
  };

  // INSERT audit_log com onConflict do idempotency_key — se já existe, ignora
  const { error: auditErr } = await supabase
    .from("audit_log")
    .insert(auditPayload)
    .select()
    .single();

  if (auditErr && !auditErr.message.includes("duplicate key")) {
    throw new Error(`INSERT audit_log: ${auditErr.message}`);
  }

  // 6. card_event AcaoExecutada (sucesso ou falha)
  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: sswResult.ok ? "AcaoExecutada" : "AcaoFalhou",
    actor_type: "agent",
    actor_id: "executor",
    payload: {
      todo_id: m.todo_id,
      action_id: m.action_id,
      tool: "lancar_ocorrencia",
      codigo_ssw: codigoSsw,
      codigo_api: codigoApi,
      nf,
      chave_cte: chaveCTe,
      cnpj_remetente: cnpjRemetente,
      protocolo: sswResult.ok ? sswResult.protocolo : null,
      idempotency_key: sswResult.idempotencyKey,
      sucesso: sswResult.ok,
      error: sswResult.ok ? null : sswResult.error,
      status_http: sswResult.ok ? 200 : sswResult.status,
    },
  });

  // 7. UPDATE todo
  if (sswResult.ok) {
    await supabase
      .from("todos")
      .update({ status: "executando" })
      .eq("id", m.todo_id);

    await supabase
      .from("cards")
      .update({ state: "EXECUTANDO_ACAO" })
      .eq("id", m.card_id);

    summary.executed++;
  } else {
    await supabase
      .from("todos")
      .update({ status: "falhou", rejection_reason: sswResult.error.slice(0, 500) })
      .eq("id", m.todo_id);

    await supabase
      .from("cards")
      .update({ state: "BLOQUEADO_POR_ERRO" })
      .eq("id", m.card_id);

    summary.failed++;
  }

  // 8. Confirma processamento
  await supabase.rpc("delete_from_pgmq", { queue_name: "agent_executor", msg_id: job.msg_id });
}
