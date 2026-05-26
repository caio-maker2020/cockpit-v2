// =============================================================================
// refresh-historico-cards-com-oc21 — cron a cada 6h. Garante que cards com
// oc=21 OU oc=13 ativos tenham historico_ssw fresh, pra que:
//   - aba PRIORIDADES AI mostre TODAS as oc=21/13 (view exige historico_ssw)
//   - tracking de tempo 21→14 + alertas SLA enxerguem oc=14 quando chegar
//
// Caio 2026-05-26 (NF aba PRIORIDADES AI vazia): antes pegava SÓ cards com
// AcaoExecutada codigo_ssw=21 nos últimos 5d. Excluía: cards com oc=21
// vindos direto do Bastão (lançados em outro sistema) E todos cards oc=13.
// 138 NFs invisíveis na aba.
//
// Fix: filtro por `cod_ultima_ocorrencia IN (13, 21) AND state NOT IN
// ('RESOLVIDO','CANCELADO') AND ctrc IS NOT NULL` — pega TODOS cards ativos
// independente da origem da oc.
//
// Skip se card já tem oc=14 no histórico atual (objetivo atingido).
// Skip se histórico foi atualizado há menos de 5h (evita rate-limit).
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
const BATCH_MAX = 250; // teto pra não estourar timeout 300s da edge

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

  // 1. Caio 2026-05-26: filtra direto em `cards` pelo cod_ultima_ocorrencia.
  // Cobre cards oc=21/13 vindos do Bastão (sem AcaoExecutada no Cockpit) e
  // cards mais antigos que a janela de 5d antiga. Aba PRIORIDADES AI exige
  // historico_ssw populado pra mostrar eventos — sem este refresh, NFs ficam
  // invisíveis na aba.
  //
  // Prioriza cards SEM historico_ssw primeiro (NULL first), depois os mais
  // desatualizados. BATCH_MAX limita por ciclo pra não estourar timeout 300s.
  const limiarUltimoRefresh = new Date(Date.now() - REFRESH_MIN_INTERVAL_HORAS * 60 * 60 * 1000);

  const { data: candidatos, error: selErr } = await supabase
    .from("cards")
    .select("id, historico_ssw, historico_ssw_atualizado_em")
    .in("cod_ultima_ocorrencia", [13, 21])
    .not("state", "in", "(RESOLVIDO,CANCELADO)")
    .not("ctrc", "is", null)
    .or(`historico_ssw.is.null,historico_ssw_atualizado_em.lt.${limiarUltimoRefresh.toISOString()}`)
    .order("historico_ssw_atualizado_em", { ascending: true, nullsFirst: true })
    .limit(BATCH_MAX);

  if (selErr) {
    return json({ ok: false, error: `SELECT cards: ${selErr.message}` }, 500);
  }

  summary.candidatos = (candidatos ?? []).length;

  if (summary.candidatos === 0) {
    summary.duration_ms = Date.now() - start;
    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 2. Pra cada card já carregado no SELECT acima — itera.
  const cards = candidatos ?? [];

  for (const card of cards as Array<Record<string, unknown>>) {
    const cardId = card["id"] as string;
    const historico = (card["historico_ssw"] as Array<Record<string, unknown>> | null) ?? [];
    const atualizadoEm = card["historico_ssw_atualizado_em"] as string | null;

    // Skip se tem oc=14 DEPOIS de oc=21 (par completo — não precisa refresh).
    // Caio 2026-05-18: bug anterior considerava qualquer oc=14, mesmo antes da 21,
    // o que descartava cards onde o histórico estava desatualizado (oc=21 nem
    // tinha sido capturada ainda mas tinha oc=14 antiga de tentativa original).
    const data21s: number[] = [];
    const data14s: number[] = [];
    for (const h of historico) {
      const cod = Number(h["codigo"]);
      const dataStr = h["data"] as string | undefined;
      if (!dataStr) continue;
      const m = dataStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})$/);
      if (!m) continue;
      const ts = Date.UTC(2000 + Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]) + 3, Number(m[5]));
      if (cod === 21) data21s.push(ts);
      else if (cod === 14) data14s.push(ts);
    }
    const ultima21 = data21s.length > 0 ? Math.max(...data21s) : null;
    const tem14DepoisDeUltima21 = ultima21 !== null && data14s.some((t) => t > ultima21);
    if (tem14DepoisDeUltima21) {
      summary.ja_tem_oc14++;
      continue;
    }

    // Skip se atualizado recentemente (evita rate-limit SSW)
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
