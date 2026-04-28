// =============================================================================
// sync-bastao — Edge Function (Deno runtime)
//
// 3 passes em ordem:
//   Pass A — discover: importa pendências do Bastão filtradas por
//            OCORRENCIAS_DE_RELACIONAMENTO + BASTAO_TEST_FILTER_OPERATOR.
//            Cria card OU atualiza dados sincronizados.
//   Pass B — release: cards ativos no Cockpit cuja pendência no Bastão
//            (lookup por NF) saiu do escopo do Relacionamento → fecha card
//            como RESOLVIDO + grava DevolvidoParaOperacao.
//   Pass C — verify: todos.status='executando' → checa se a ocorrência
//            esperada (proposta_payload.args.codigo) já apareceu no Bastão.
//
// IMPORTANTE — Bastão regenera os UUIDs de pendências.id a cada update
// (DELETE + INSERT no upstream a cada ~40min). Por isso o match Cockpit ↔ Bastão
// é feito por (nf, ctrc), não por bastao_pendencia_id. O campo
// bastao_pendencia_id em cards continua sendo populado pra debug e auditoria,
// mas não é chave estável.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createBastaoClient,
  readBastaoEnvFromProcess,
  type BastaoPendencia,
} from "../_shared/bastao-client.ts";
import {
  OCORRENCIAS_DE_RELACIONAMENTO,
  VERIFICATION_TIMEOUT_MINUTES,
} from "../_shared/bastao-rules.ts";

interface PassASummary {
  pulled: number;
  created: number;
  updated: number;
  unchanged: number;
}

interface PassBSummary {
  checked: number;
  released: number;
  not_found_in_bastao: number;
}

interface PassCSummary {
  pending: number;
  confirmed: number;
  timed_out: number;
  still_waiting: number;
}

interface SyncSummary {
  pass_a: PassASummary;
  pass_b: PassBSummary;
  pass_c: PassCSummary;
  errors: Array<{ pass: string; ref: string; message: string }>;
  duration_ms: number;
}

serve(async (req) => {
  const startedAt = Date.now();

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const bastao = createBastaoClient({ env: readBastaoEnvFromProcess(env) });

    const errors: SyncSummary["errors"] = [];

    const passA = await runPassA(supabase, bastao, errors);
    const passB = await runPassB(supabase, bastao, errors);
    const passC = await runPassC(supabase, bastao, errors);

    const summary: SyncSummary = {
      pass_a: passA,
      pass_b: passB,
      pass_c: passC,
      errors,
      duration_ms: Date.now() - startedAt,
    };

    console.log("Sync done:", JSON.stringify(summary));

    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("sync-bastao fatal:", message);
    return new Response(
      JSON.stringify({ error: message, duration_ms: Date.now() - startedAt }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

// =============================================================================
// PASS A — discover
// =============================================================================

type SupabaseClient = ReturnType<typeof createClient>;
type BastaoClient = ReturnType<typeof createBastaoClient>;

async function runPassA(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  errors: SyncSummary["errors"],
): Promise<PassASummary> {
  const pendencias = await bastao.fetchPendenciasDoCockpit();
  console.log(`[A] Bastão retornou ${pendencias.length} pendências.`);

  const summary: PassASummary = {
    pulled: pendencias.length,
    created: 0,
    updated: 0,
    unchanged: 0,
  };

  for (const p of pendencias) {
    try {
      const result = await upsertCardFromPendencia(supabase, p);
      if (result === "created") summary.created++;
      else if (result === "updated") summary.updated++;
      else summary.unchanged++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const ref = `${p.nf ?? "?"}/${p.ctrc ?? "?"}`;
      console.error(`[A] Erro pendência ${ref}: ${message}`);
      errors.push({ pass: "A", ref, message });
    }
  }

  return summary;
}

type UpsertResult = "created" | "updated" | "unchanged";

/**
 * Match Cockpit ↔ Bastão por NF (chave natural estável). Bastão regenera
 * UUIDs ao atualizar, então `bastao_pendencia_id` é só snapshot.
 */
async function upsertCardFromPendencia(
  supabase: SupabaseClient,
  p: BastaoPendencia,
): Promise<UpsertResult> {
  if (!p.nf) {
    // Sem NF não temos como matchar; pula.
    return "unchanged";
  }

  const { data: existingRows, error: selectErr } = await supabase
    .from("cards")
    .select("id, cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia, state, bastao_pendencia_id")
    .eq("nf", p.nf)
    .not("state", "in", "(RESOLVIDO,CANCELADO)")
    .limit(1);

  if (selectErr) {
    throw new Error(`SELECT cards by nf: ${selectErr.message}`);
  }

  const existing = existingRows?.[0] ?? null;

  if (existing) {
    const changedOcorrencia = existing.cod_ultima_ocorrencia !== p.cod_ultima_ocorrencia;
    const changedData = existing.bastao_data_ultima_ocorrencia !== p.data_ultima_ocorrencia;

    const { error: updErr } = await supabase
      .from("cards")
      .update({
        bastao_pendencia_id: p.id, // snapshot do último uuid (efêmero no Bastão)
        cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
        bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
        bastao_synced_at: new Date().toISOString(),
        empresa_cliente: p.pagador,
        pagador: p.pagador,
        base_destino: p.base_destino,
        responsavel_relacionamento: p.responsavel_relacionamento,
        agent_state: snapshotFromPendencia(p),
      })
      .eq("id", existing.id);

    if (updErr) throw new Error(`UPDATE cards: ${updErr.message}`);

    if (changedOcorrencia || changedData) {
      const { error: evErr } = await supabase.from("card_events").insert({
        card_id: existing.id,
        event_type: "BastaoCardAtualizado",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          previous: {
            cod_ultima_ocorrencia: existing.cod_ultima_ocorrencia,
            bastao_data_ultima_ocorrencia: existing.bastao_data_ultima_ocorrencia,
          },
          current: snapshotFromPendencia(p),
        },
      });
      if (evErr) throw new Error(`INSERT card_events (atualizado): ${evErr.message}`);
      return "updated";
    }
    // bastao_pendencia_id pode ter mudado (UUIDs efêmeros), mas isso não é
    // mudança semântica — não contamos como updated nem geramos evento.
    return "unchanged";
  }

  const newState =
    p.cod_ultima_ocorrencia === 54 ? "AGUARDANDO_CLIENTE" : "AGUARDANDO_AGENTE";

  const { data: insertedCard, error: insErr } = await supabase
    .from("cards")
    .insert({
      nf: p.nf,
      ctrc: p.ctrc,
      canal_origem: "sistema",
      empresa_cliente: p.pagador,
      pagador: p.pagador,
      base_destino: p.base_destino,
      responsavel_relacionamento: p.responsavel_relacionamento,
      state: newState,
      tipo: null,
      risco: "baixo",
      assigned_agent: null,
      assigned_operator_id: null,
      bastao_pendencia_id: p.id,
      cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
      bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
      bastao_synced_at: new Date().toISOString(),
      agent_state: snapshotFromPendencia(p),
    })
    .select("id")
    .single();

  if (insErr) throw new Error(`INSERT cards: ${insErr.message}`);

  const { error: evErr } = await supabase.from("card_events").insert({
    card_id: insertedCard.id,
    event_type: "BastaoCardImportado",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: snapshotFromPendencia(p),
  });
  if (evErr) throw new Error(`INSERT card_events (importado): ${evErr.message}`);

  return "created";
}

// =============================================================================
// PASS B — release: cards que sairam do escopo do Relacionamento
// =============================================================================

async function runPassB(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  errors: SyncSummary["errors"],
): Promise<PassBSummary> {
  // 1. Cards ativos no Cockpit com bastao_pendencia_id (= importados do Bastão)
  //    e que TÊM nf (sem nf não dá pra fazer lookup).
  const { data: activeCards, error: selErr } = await supabase
    .from("cards")
    .select("id, nf, cod_ultima_ocorrencia, state")
    .not("state", "in", "(RESOLVIDO,CANCELADO)")
    .not("bastao_pendencia_id", "is", null)
    .not("nf", "is", null);

  if (selErr) {
    errors.push({ pass: "B", ref: "select_active_cards", message: selErr.message });
    return { checked: 0, released: 0, not_found_in_bastao: 0 };
  }

  const cards = activeCards ?? [];
  if (cards.length === 0) {
    return { checked: 0, released: 0, not_found_in_bastao: 0 };
  }

  // 2. Estado atual no Bastão por NF (1 query por card — Bastão não tem
  //    `nf=in.(...)` performático com 30+ valores; vamos sequencial)
  let released = 0;
  let notFound = 0;

  for (const card of cards) {
    const nf = card.nf as string;
    let current: BastaoPendencia | null;
    try {
      current = await bastao.fetchPendenciaByNf(nf);
    } catch (err) {
      errors.push({
        pass: "B",
        ref: `nf=${nf}`,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!current) {
      notFound++;
      continue;
    }

    const newCod = current.cod_ultima_ocorrencia;
    const stillInScope = newCod != null && OCORRENCIAS_DE_RELACIONAMENTO.has(newCod);
    if (stillInScope) continue;

    try {
      await releaseCard(supabase, card.id as string, card.cod_ultima_ocorrencia, current);
      released++;
    } catch (err) {
      errors.push({
        pass: "B",
        ref: card.id as string,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { checked: cards.length, released, not_found_in_bastao: notFound };
}

async function releaseCard(
  supabase: SupabaseClient,
  cardId: string,
  previousCod: number | null,
  current: BastaoPendencia,
): Promise<void> {
  const { error: evErr } = await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "DevolvidoParaOperacao",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      motivo: "cod_ultima_ocorrencia mudou pra fora do escopo do Relacionamento",
      previous_cod: previousCod,
      new_cod: current.cod_ultima_ocorrencia,
      new_descricao_instrucao: current.instrucao_ultima_ocorrencia,
      new_data_ocorrencia: current.data_ultima_ocorrencia,
    },
  });
  if (evErr) throw new Error(`INSERT card_events (released): ${evErr.message}`);

  const { error: updErr } = await supabase
    .from("cards")
    .update({
      state: "RESOLVIDO",
      bastao_pendencia_id: current.id,
      cod_ultima_ocorrencia: current.cod_ultima_ocorrencia,
      bastao_data_ultima_ocorrencia: current.data_ultima_ocorrencia,
      bastao_synced_at: new Date().toISOString(),
    })
    .eq("id", cardId);
  if (updErr) throw new Error(`UPDATE cards (released): ${updErr.message}`);
}

// =============================================================================
// PASS C — verify: todos em "executando" → confirmar ou marcar timeout
// =============================================================================

async function runPassC(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  errors: SyncSummary["errors"],
): Promise<PassCSummary> {
  const { data: pendingTodos, error: selErr } = await supabase
    .from("todos")
    .select(`
      id, card_id, proposta_payload, approved_at,
      cards!inner(id, nf)
    `)
    .eq("status", "executando")
    .not("cards.nf", "is", null);

  if (selErr) {
    errors.push({ pass: "C", ref: "select_executando", message: selErr.message });
    return { pending: 0, confirmed: 0, timed_out: 0, still_waiting: 0 };
  }

  const todos = pendingTodos ?? [];
  if (todos.length === 0) {
    return { pending: 0, confirmed: 0, timed_out: 0, still_waiting: 0 };
  }

  let confirmed = 0;
  let timedOut = 0;
  let stillWaiting = 0;
  const now = Date.now();
  const timeoutMs = VERIFICATION_TIMEOUT_MINUTES * 60 * 1000;

  for (const t of todos) {
    try {
      const cardRef = (t as Record<string, unknown>)["cards"] as
        | { id: string; nf: string | null }
        | { id: string; nf: string | null }[]
        | null;
      const ref = Array.isArray(cardRef) ? cardRef[0] : cardRef;
      const nf = ref?.nf;
      if (!nf) {
        stillWaiting++;
        continue;
      }

      const current = await bastao.fetchPendenciaByNf(nf);
      if (!current) {
        stillWaiting++;
        continue;
      }

      const expected = parseExpectedCodigo(t.proposta_payload);
      if (!expected) {
        stillWaiting++;
        continue;
      }

      if (current.cod_ultima_ocorrencia === expected) {
        await markTodoExecutado(supabase, t, current, expected);
        confirmed++;
      } else {
        const approvedAt = t.approved_at ? new Date(t.approved_at).getTime() : now;
        const elapsed = now - approvedAt;
        if (elapsed > timeoutMs) {
          await markTodoFalhou(supabase, t, current, expected, elapsed);
          timedOut++;
        } else {
          stillWaiting++;
        }
      }
    } catch (err) {
      errors.push({
        pass: "C",
        ref: String(t.id),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { pending: todos.length, confirmed, timed_out: timedOut, still_waiting: stillWaiting };
}

function parseExpectedCodigo(proposta: unknown): number | null {
  if (!proposta || typeof proposta !== "object") return null;
  const args = (proposta as Record<string, unknown>)["args"];
  if (!args || typeof args !== "object") return null;
  const codigo = (args as Record<string, unknown>)["codigo"];
  if (codigo == null) return null;
  const n = typeof codigo === "number" ? codigo : parseInt(String(codigo), 10);
  return Number.isFinite(n) ? n : null;
}

async function markTodoExecutado(
  supabase: SupabaseClient,
  todo: Record<string, unknown>,
  current: BastaoPendencia,
  expected: number,
): Promise<void> {
  const todoId = todo["id"] as string;
  const cardId = todo["card_id"] as string;

  const { error: evErr } = await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "OcorrenciaSSWConfirmada",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      todo_id: todoId,
      codigo_confirmado: expected,
      data_ocorrencia: current.data_ultima_ocorrencia,
      instrucao: current.instrucao_ultima_ocorrencia,
    },
  });
  if (evErr) throw new Error(`INSERT card_events (confirmada): ${evErr.message}`);

  const { error: updErr } = await supabase
    .from("todos")
    .update({ status: "executado" })
    .eq("id", todoId);
  if (updErr) throw new Error(`UPDATE todos (executado): ${updErr.message}`);
}

async function markTodoFalhou(
  supabase: SupabaseClient,
  todo: Record<string, unknown>,
  current: BastaoPendencia,
  expected: number,
  elapsedMs: number,
): Promise<void> {
  const todoId = todo["id"] as string;
  const cardId = todo["card_id"] as string;

  const { error: evErr } = await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "AcaoExecutadaSemConfirmacao",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      todo_id: todoId,
      codigo_esperado: expected,
      codigo_atual: current.cod_ultima_ocorrencia,
      minutos_decorridos: Math.round(elapsedMs / 60000),
      timeout_minutos: VERIFICATION_TIMEOUT_MINUTES,
      motivo: "Ocorrência esperada não apareceu no Bastão dentro do prazo",
    },
  });
  if (evErr) throw new Error(`INSERT card_events (falhou): ${evErr.message}`);

  const { error: updTodoErr } = await supabase
    .from("todos")
    .update({ status: "falhou" })
    .eq("id", todoId);
  if (updTodoErr) throw new Error(`UPDATE todos (falhou): ${updTodoErr.message}`);

  const { error: updCardErr } = await supabase
    .from("cards")
    .update({ state: "BLOQUEADO_POR_ERRO" })
    .eq("id", cardId);
  if (updCardErr) throw new Error(`UPDATE cards (BLOQUEADO_POR_ERRO): ${updCardErr.message}`);
}

// =============================================================================
// helpers
// =============================================================================

function snapshotFromPendencia(p: BastaoPendencia) {
  return {
    bastao_pendencia_id: p.id,
    cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
    instrucao_ultima_ocorrencia: p.instrucao_ultima_ocorrencia,
    data_ultima_ocorrencia: p.data_ultima_ocorrencia,
    cnpj_remetente: p.cnpj_remetente,
    remetente: p.remetente,
    cnpj_pagador: p.cnpj_pagador,
    cnpj_destinatario: p.cnpj_destinatario,
    destinatario: p.destinatario,
    uf_destino: p.uf_destino,
    cidade_destino: p.cidade_destino,
    base_destino: p.base_destino,
    unidade_atual: p.unidade_atual,
    dias_atraso: p.atraso_original,
    previsao_entrega: p.previsao_entrega,
    responsabilidade_cliente: p.responsabilidade_cliente,
    responsavel_atual: p.responsavel_atual,
    responsavel_relacionamento: p.responsavel_relacionamento,
    segmento_cliente: p.segmento_cliente,
    importante_acompanhar: p.importante_acompanhar,
    bastao_synced_at: new Date().toISOString(),
  };
}
