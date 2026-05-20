// =============================================================================
// cron-sync-prioridades-ai — atualização autônoma da aba PRIORIDADES AI
//
// Caio 2026-05-20: rodar 5×/dia (07/09/11/14/16 BRT) pra detectar se cards do
// kanban tiveram movimento no SSW. Equivalente ao botão "Atualizar Geral" do
// front, mas autônomo. Operador vê "Última sync: há X minutos" no header.
//
// Fluxo:
//   1. SELECT card_id FROM v_prioridades_ai (cards ativos no kanban)
//   2. INSERT sync_runs com summary->>'tipo' = 'cron_prioridades_ai' status=running
//   3. Pra cada card_id em paralelo (concorrência 5, limit 100 por run):
//      → POST /functions/v1/puxar-historico-ssw-card { card_id }
//   4. UPDATE sync_runs com finished_at, status, summary completo
//
// Limite de 100 cards por run pra não estourar timeout (60s default). Se houver
// mais que 100, o próximo cron pega no horário seguinte. View prioriza ordem
// por dias_uteis_parados DESC (cards mais críticos primeiro).
//
// Idempotente: chamadas concorrentes não causam corrupção (cada run vira linha
// nova em sync_runs). Mas pra economizar SSW, skip se houver run iniciado nos
// últimos 5min ainda em status='running'.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYNC_TIPO = "cron_prioridades_ai";
// Caio 2026-05-20 (calibração pós-smoke): 5 concorrência derrubou 41% por
// rate limit do gateway Supabase Functions. Concorrência 2 + delay 500ms
// entre batches + limit 50 mantém ~95% ok. 5 crons/dia cobrem ~250 cards.
const MAX_CARDS_POR_RUN = 50;
const CONCORRENCIA = 2;
const DELAY_ENTRE_BATCHES_MS = 500;
const SKIP_SE_RUN_RECENTE_MIN = 5;

interface RunSummary {
  tipo: string;
  total_no_kanban: number;
  processados: number;
  ok: number;
  falhou: number;
  duration_ms: number;
  erros: Array<{ card_id: string; message: string }>;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function processarEmBatches<T, R>(
  items: T[],
  concorrencia: number,
  fn: (item: T) => Promise<R>,
  delayMs = 0,
): Promise<R[]> {
  const resultados: R[] = [];
  for (let i = 0; i < items.length; i += concorrencia) {
    const batch = items.slice(i, i + concorrencia);
    const r = await Promise.all(batch.map(fn));
    resultados.push(...r);
    if (delayMs > 0 && i + concorrencia < items.length) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  return resultados;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const env = Deno.env.toObject();
  const supabase = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const start = Date.now();

  // 1. Skip se já há run em andamento recente
  const { data: runEmAndamento } = await supabase
    .from("sync_runs")
    .select("id, started_at")
    .eq("status", "running")
    .gt("started_at", new Date(Date.now() - SKIP_SE_RUN_RECENTE_MIN * 60_000).toISOString())
    .order("started_at", { ascending: false })
    .limit(1);

  if (runEmAndamento && runEmAndamento.length > 0) {
    return jsonResp({
      ok: true,
      skipped: true,
      reason: `Run anterior ainda em andamento (id=${(runEmAndamento[0] as { id: string }).id})`,
    });
  }

  // 2. Insere sync_runs em status=running
  const { data: run, error: runErr } = await supabase
    .from("sync_runs")
    .insert({ status: "running", summary: { tipo: SYNC_TIPO } })
    .select("id")
    .single();

  if (runErr || !run) {
    return jsonResp({ ok: false, error: `INSERT sync_runs: ${runErr?.message}` }, 500);
  }
  const runId = (run as { id: string }).id;

  try {
    // 3a. Resolve operadores com cockpit_ativo=true. Caio 2026-05-20:
    // só rodar pra quem está em produção no Cockpit. Quando ativar novo
    // operador (UPDATE operadores SET cockpit_ativo=true), entra no cron
    // automaticamente sem mudança de código.
    const { data: opAtivos, error: opErr } = await supabase
      .from("operadores")
      .select("nome")
      .eq("ativo", true)
      .eq("cockpit_ativo", true);

    if (opErr) {
      throw new Error(`SELECT operadores: ${opErr.message}`);
    }
    const nomesAtivos = ((opAtivos ?? []) as Array<{ nome: string }>)
      .map((o) => o.nome);

    if (nomesAtivos.length === 0) {
      // Skip silencioso: nenhum operador ativo no Cockpit
      const duration = Date.now() - start;
      await supabase
        .from("sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          duration_ms: duration,
          status: "succeeded",
          summary: {
            tipo: SYNC_TIPO,
            total_no_kanban: 0,
            processados: 0,
            ok: 0,
            falhou: 0,
            duration_ms: duration,
            erros: [],
            nota: "nenhum operador com cockpit_ativo=true",
          },
        })
        .eq("id", runId);
      return jsonResp({ ok: true, run_id: runId, skipped: false, processados: 0 });
    }

    // 3b. Lista cards ativos no kanban, filtrados pelos operadores ativos
    const { data: cards, error: viewErr } = await supabase
      .from("v_prioridades_ai")
      .select("card_id, dias_uteis_parados")
      .in("responsavel_relacionamento", nomesAtivos)
      .order("dias_uteis_parados", { ascending: false, nullsFirst: false })
      .limit(MAX_CARDS_POR_RUN);

    if (viewErr) {
      throw new Error(`SELECT v_prioridades_ai: ${viewErr.message}`);
    }

    const cardIds: string[] = ((cards ?? []) as Array<{ card_id: string }>)
      .map((c) => c.card_id);

    // 4. Processa em paralelo (concorrência limitada + delay anti-rate-limit)
    const erros: Array<{ card_id: string; message: string }> = [];
    let ok = 0;
    let falhou = 0;

    await processarEmBatches<string, void>(cardIds, CONCORRENCIA, async (cardId) => {
      try {
        const r = await fetch(
          `${env["SUPABASE_URL"]}/functions/v1/puxar-historico-ssw-card`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
              "apikey": env["SUPABASE_SERVICE_ROLE_KEY"]!,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ card_id: cardId }),
            signal: AbortSignal.timeout(45_000),
          },
        );
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          erros.push({
            card_id: cardId,
            message: `HTTP ${r.status}: ${txt.slice(0, 200)}`,
          });
          falhou++;
          return;
        }
        const data = await r.json();
        if (data?.ok) ok++;
        else {
          erros.push({ card_id: cardId, message: data?.error ?? "sem ok=true" });
          falhou++;
        }
      } catch (e) {
        erros.push({
          card_id: cardId,
          message: e instanceof Error ? e.message : String(e),
        });
        falhou++;
      }
    }, DELAY_ENTRE_BATCHES_MS);

    // Caio 2026-05-20: registra cards que saíram do kanban após este refresh
    // (Bastão/SSW pode ter avançado). Front consulta v_prioridades_ai_saidas_recentes.
    let saidasRegistradas = 0;
    if (cardIds.length > 0) {
      const { data: regResult } = await supabase.rpc("registrar_saidas_kanban", {
        p_card_ids: cardIds,
        p_fonte: "cron_autonomo",
      });
      saidasRegistradas = typeof regResult === "number" ? regResult : 0;
    }

    const duration = Date.now() - start;
    const summary: RunSummary & { saidas_registradas?: number } = {
      tipo: SYNC_TIPO,
      total_no_kanban: cardIds.length,
      processados: cardIds.length,
      ok,
      falhou,
      duration_ms: duration,
      erros: erros.slice(0, 20),
      saidas_registradas: saidasRegistradas,
    };

    await supabase
      .from("sync_runs")
      .update({
        finished_at: new Date().toISOString(),
        duration_ms: duration,
        status: falhou === cardIds.length && cardIds.length > 0 ? "failed" : "succeeded",
        errors_count: falhou,
        summary,
      })
      .eq("id", runId);

    return jsonResp({ ok: true, run_id: runId, summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabase
      .from("sync_runs")
      .update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - start,
        status: "failed",
        summary: { tipo: SYNC_TIPO, fatal: message },
      })
      .eq("id", runId);
    return jsonResp({ ok: false, run_id: runId, error: message }, 500);
  }
});
