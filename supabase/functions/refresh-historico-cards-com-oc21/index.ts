// =============================================================================
// refresh-historico-cards-com-oc21 — cron a cada 6h. Garante que cards onde
// operador aprovou oc=21 nos últimos 5 dias tenham historico_ssw fresh, pra
// que o tracking de tempo 21→14 + alertas SLA enxerguem a oc=14 quando chegar.
//
// Skip se card já tem oc=14 no histórico atual (objetivo atingido).
// Skip se histórico foi atualizado há menos de 5h (evita rate-limit).
//
// Caio 2026-05-18.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

interface Summary {
  candidatos: number;
  refresh_ok: number;
  refresh_falhou: number;
  ja_atualizado_recente: number;
  ja_tem_oc14: number;
  duration_ms: number;
  erros: Array<{ card_id: string; message: string }>;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const REFRESH_MIN_INTERVAL_HORAS = 5; // não puxa de novo se já puxou há <5h
const JANELA_OC21_DIAS = 5;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const start = Date.now();
  const env = Deno.env.toObject();
  const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const summary: Summary = {
    candidatos: 0,
    refresh_ok: 0,
    refresh_falhou: 0,
    ja_atualizado_recente: 0,
    ja_tem_oc14: 0,
    duration_ms: 0,
    erros: [],
  };

  // 1. Lista cards onde houve AcaoExecutada com codigo_ssw=21 nos últimos N dias.
  // Cada card aparece 1x (DISTINCT via subquery).
  const inicioJanela = new Date(Date.now() - JANELA_OC21_DIAS * 24 * 60 * 60 * 1000).toISOString();
  const { data: eventos, error: selErr } = await supabase
    .from("card_events")
    .select("card_id")
    .eq("event_type", "AcaoExecutada")
    .filter("payload->>codigo_ssw", "eq", "21")
    .filter("payload->>sucesso", "eq", "true")
    .gte("created_at", inicioJanela)
    .limit(2000);

  if (selErr) {
    return json({ ok: false, error: `SELECT card_events: ${selErr.message}` }, 500);
  }

  const cardIds = [...new Set((eventos ?? []).map((e) => e.card_id as string))];
  summary.candidatos = cardIds.length;

  if (cardIds.length === 0) {
    summary.duration_ms = Date.now() - start;
    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 2. Pra cada card: carrega historico_ssw atual + atualizado_em.
  const { data: cards } = await supabase
    .from("cards")
    .select("id, historico_ssw, historico_ssw_atualizado_em")
    .in("id", cardIds);

  const limiarUltimoRefresh = new Date(Date.now() - REFRESH_MIN_INTERVAL_HORAS * 60 * 60 * 1000);

  for (const card of (cards ?? []) as Array<Record<string, unknown>>) {
    const cardId = card["id"] as string;
    const historico = (card["historico_ssw"] as Array<Record<string, unknown>> | null) ?? [];
    const atualizadoEm = card["historico_ssw_atualizado_em"] as string | null;

    // Skip se já tem oc=14
    const temOc14 = historico.some((h) => Number(h["codigo"]) === 14);
    if (temOc14) {
      summary.ja_tem_oc14++;
      continue;
    }

    // Skip se atualizado recentemente
    if (atualizadoEm && new Date(atualizadoEm) > limiarUltimoRefresh) {
      summary.ja_atualizado_recente++;
      continue;
    }

    // Força puxar histórico via edge function existente. Edge-to-edge usando
    // supabase.functions.invoke() ao invés de fetch direto pra evitar problemas
    // de JWT format no gateway (chamada com service_role direto via Bearer
    // estava retornando UNAUTHORIZED_INVALID_JWT_FORMAT).
    try {
      const { data, error } = await supabase.functions.invoke("puxar-historico-ssw-card", {
        body: { card_id: cardId },
      });
      if (!error && data && (data as Record<string, unknown>).ok === true) {
        summary.refresh_ok++;
      } else {
        summary.refresh_falhou++;
        const errMsg = error?.message ?? (data as Record<string, unknown>)?.error ?? "unknown";
        summary.erros.push({ card_id: cardId, message: String(errMsg).slice(0, 300) });
      }
    } catch (err) {
      summary.refresh_falhou++;
      summary.erros.push({ card_id: cardId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  summary.duration_ms = Date.now() - start;
  console.log("refresh-historico-cards-com-oc21:", JSON.stringify(summary));

  return new Response(JSON.stringify(summary, null, 2), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
