// =============================================================================
// sync-bastao — Edge Function (Deno runtime)
//
// Pass A — discover (MVP): puxa do Bastão as pendências do operador de teste
// nas 16 ocorrências do Cockpit, e materializa cards no Cockpit (CREATE) ou
// atualiza dados sincronizados (UPDATE).
//
// Pass B (release) e Pass C (verify) ficam pra próxima iteração.
//
// Convenções:
//   - Service role bypassa RLS — pode escrever cards/card_events sem fricção.
//   - Cada novo card grava 1 card_event 'BastaoCardImportado'.
//   - Card existente que mudou ganha 1 card_event 'BastaoCardAtualizado'.
//   - Idempotente: rodar 2x não duplica cards (unique parcial bastao_pendencia_id).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createBastaoClient,
  readBastaoEnvFromProcess,
  type BastaoPendencia,
} from "../_shared/bastao-client.ts";

interface SyncSummary {
  bastao_pulled: number;
  cockpit_created: number;
  cockpit_updated: number;
  cockpit_unchanged: number;
  errors: Array<{ pendencia_id: string; message: string }>;
  duration_ms: number;
}

serve(async (req) => {
  const startedAt = Date.now();

  // CORS preflight (raro pra Edge Function chamada por cron, mas seguro)
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
    const supabaseUrl = env["SUPABASE_URL"]!;
    const serviceRoleKey = env["SUPABASE_SERVICE_ROLE_KEY"]!;

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const bastao = createBastaoClient({ env: readBastaoEnvFromProcess(env) });

    // --- Pass A: discover --------------------------------------------------
    const pendencias = await bastao.fetchPendenciasDoCockpit();
    console.log(`Bastão retornou ${pendencias.length} pendências.`);

    const summary: SyncSummary = {
      bastao_pulled: pendencias.length,
      cockpit_created: 0,
      cockpit_updated: 0,
      cockpit_unchanged: 0,
      errors: [],
      duration_ms: 0,
    };

    for (const p of pendencias) {
      try {
        const result = await upsertCardFromPendencia(supabase, p);
        if (result === "created") summary.cockpit_created++;
        else if (result === "updated") summary.cockpit_updated++;
        else summary.cockpit_unchanged++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Erro processando pendência ${p.id}: ${message}`);
        summary.errors.push({ pendencia_id: p.id, message });
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    console.log("Sync done:", summary);

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

type SupabaseClient = ReturnType<typeof createClient>;
type UpsertResult = "created" | "updated" | "unchanged";

async function upsertCardFromPendencia(
  supabase: SupabaseClient,
  p: BastaoPendencia,
): Promise<UpsertResult> {
  // 1. Tenta achar card já vinculado a essa pendência
  const { data: existing, error: selectErr } = await supabase
    .from("cards")
    .select("id, cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia, state")
    .eq("bastao_pendencia_id", p.id)
    .not("state", "in", "(RESOLVIDO,CANCELADO)")
    .maybeSingle();

  if (selectErr) {
    throw new Error(`SELECT cards by bastao_pendencia_id: ${selectErr.message}`);
  }

  if (existing) {
    // Card já existe — atualiza só se mudou cod_ultima_ocorrencia ou data
    const changedOcorrencia = existing.cod_ultima_ocorrencia !== p.cod_ultima_ocorrencia;
    const changedData =
      existing.bastao_data_ultima_ocorrencia !== p.data_ultima_ocorrencia;

    // Sempre atualiza bastao_synced_at — evidência de que sync rodou
    const { error: updErr } = await supabase
      .from("cards")
      .update({
        cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
        bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
        bastao_synced_at: new Date().toISOString(),
        // Atualiza dados que podem mudar no Bastão
        empresa_cliente: p.pagador,
        pagador: p.pagador,
        base_destino: p.base_destino,
        responsavel_relacionamento: p.responsavel_relacionamento,
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
    return "unchanged";
  }

  // 2. Card novo — cria
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
      tipo: null,           // triador classifica quando 1ª mensagem chegar
      risco: "baixo",        // default — ajustável manual ou via agente
      assigned_agent: null,
      assigned_operator_id: null, // resolver pelo nome quando operadores tiverem rows
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

function snapshotFromPendencia(p: BastaoPendencia) {
  // Snapshot enxuto pra agent_state (campos que agentes vão usar pra decidir)
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
