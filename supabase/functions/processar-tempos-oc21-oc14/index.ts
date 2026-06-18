// =============================================================================
// processar-tempos-oc21-oc14 — cron diário que extrai pares (oc=21 → próxima
// oc=14) do cards.historico_ssw e calcula delta em minutos. UPSERT idempotente.
//
// Roda 13h UTC daily. Não força puxar historico_ssw fresh — usa o que já está
// no banco. Cards inativos sem refresh ficam fora do indicador (aceitável MVP).
//
// Caio 2026-05-18.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { nowBRT } from "../_shared/brt.ts";

const SLA_MINUTOS = 24 * 60; // 1440 minutos = 24h (legado, compat). SLA real = 1 dia útil, calculado no banco.

interface HistoricoOc {
  codigo: number | null;
  descricao?: string;
  instrucao?: string;
  data: string; // dd/mm/yy HH:MM
  filial?: string;
  usuario?: string;
  tem_foto?: boolean;
}

interface Card {
  id: string;
  historico_ssw: HistoricoOc[] | null;
}

interface Summary {
  cards_processados: number;
  cards_com_par_novo: number;
  pares_novos: number;
  cards_sem_par: number;
  erros: Array<{ card_id: string; message: string }>;
  duration_ms: number;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const start = Date.now();
  const env = Deno.env.toObject();
  const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const summary: Summary = {
    cards_processados: 0,
    cards_com_par_novo: 0,
    pares_novos: 0,
    cards_sem_par: 0,
    erros: [],
    duration_ms: 0,
  };

  // 1. Lista cards com historico_ssw populado, atualizado nos últimos 120 dias.
  // Filtra os que tem oc=21 (sem 21 não tem o que medir). Filtro feito via
  // jsonb_path_exists pra performance — sem trazer JSON do banco completo.
  const { data: cards, error: selErr } = await supabase
    .from("cards")
    .select("id, historico_ssw")
    .not("historico_ssw", "is", null)
    .gte("last_event_at", new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString())
    .limit(5000); // safety limit

  if (selErr) {
    return json({ ok: false, error: `SELECT cards: ${selErr.message}` }, 500);
  }

  for (const card of (cards ?? []) as Card[]) {
    summary.cards_processados++;
    try {
      const pares = extrairPares(card.historico_ssw ?? []);
      if (pares.length === 0) {
        summary.cards_sem_par++;
        continue;
      }
      let novosEsteCard = 0;
      for (const par of pares) {
        const diasUteis = diasUteisEntre(par.data_oc21, par.data_oc14);
        const { error: insErr } = await supabase
          .from("tempo_oc21_para_oc14")
          .insert({
            card_id: card.id,
            data_oc21: par.data_oc21.toISOString(),
            data_oc14: par.data_oc14.toISOString(),
            delta_minutos: par.delta_minutos,
            dias_uteis: diasUteis,
            dentro_sla: par.delta_minutos <= SLA_MINUTOS,
            base_oc14: par.base_oc14,
            usuario_oc14: par.usuario_oc14,
            base_oc21: par.base_oc21,
            usuario_oc21: par.usuario_oc21,
          });
        if (insErr) {
          // Conflict (UNIQUE) é esperado pra pares já capturados — silencia
          if (insErr.code === "23505") continue;
          summary.erros.push({ card_id: card.id, message: insErr.message });
          continue;
        }
        novosEsteCard++;
      }
      if (novosEsteCard > 0) {
        summary.cards_com_par_novo++;
        summary.pares_novos += novosEsteCard;
      }
    } catch (err) {
      summary.erros.push({
        card_id: card.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  summary.duration_ms = Date.now() - start;
  console.log("processar-tempos-oc21-oc14:", JSON.stringify(summary));

  return new Response(JSON.stringify(summary, null, 2), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

interface Par {
  data_oc21: Date;
  data_oc14: Date;
  delta_minutos: number;
  base_oc14: string;
  usuario_oc14: string;
  base_oc21: string | null;
  usuario_oc21: string | null;
}

/**
 * Extrai pares (oc=21 → próxima oc=14) do array historico_ssw.
 *
 * Lógica:
 *  1. Filtra eventos com codigo IN (21, 14)
 *  2. Ordena por data ASC
 *  3. Itera: quando encontra 21, marca como "pending". Próximo 14 forma o par.
 *     Se vier outra 21 antes de 14, substitui a anterior (cliente pediu reentrega 2x).
 */
function extrairPares(historico: HistoricoOc[]): Par[] {
  const eventos = historico
    .filter((o) => o.codigo === 21 || o.codigo === 14)
    .map((o) => ({
      ...o,
      dataParsed: parseDataSsw(o.data),
    }))
    .filter((o) => o.dataParsed !== null)
    .sort((a, b) => a.dataParsed!.getTime() - b.dataParsed!.getTime());

  const pares: Par[] = [];
  let pending21: typeof eventos[number] | null = null;

  for (const ev of eventos) {
    if (ev.codigo === 21) {
      pending21 = ev;
    } else if (ev.codigo === 14 && pending21 !== null) {
      const data21 = pending21.dataParsed!;
      const data14 = ev.dataParsed!;
      const deltaMs = data14.getTime() - data21.getTime();
      if (deltaMs < 0) continue; // 14 antes da 21 — bug do parse ou histórico inconsistente
      pares.push({
        data_oc21: data21,
        data_oc14: data14,
        delta_minutos: Math.round(deltaMs / 60000),
        base_oc14: (ev.filial ?? "").trim() || "SEM_BASE",
        usuario_oc14: (ev.usuario ?? "").trim() || "SEM_USUARIO",
        base_oc21: (pending21.filial ?? "").trim() || null,
        usuario_oc21: (pending21.usuario ?? "").trim() || null,
      });
      pending21 = null; // par fechado
    }
  }

  return pares;
}

/**
 * Parse data SSW formato "dd/mm/yy HH:MM" → Date.
 * Retorna null se formato inválido.
 */
/**
 * Conta dias úteis (seg-sex) fracionários entre dois timestamps.
 * MVP: ignora feriados. Espelha public.dias_uteis_entre() no Postgres.
 */
function diasUteisEntre(inicioReal: Date, fimReal: Date): number {
  // Conta dias úteis no fuso de BRASÍLIA (alinha com public.dias_uteis_entre, que
  // recebe os timestamps AT TIME ZONE 'America/Sao_Paulo'). Sem o deslocamento, a
  // fronteira de dia e de fim-de-semana sairia 3h adiantada (UTC) — ex.: sexta
  // 22h BRT contaria como sábado.
  const inicio = nowBRT(inicioReal.getTime());
  const fim = nowBRT(fimReal.getTime());
  const dtIni = inicio < fim ? new Date(inicio) : new Date(fim);
  const dtFim = inicio < fim ? new Date(fim) : new Date(inicio);
  let totalDias = 0;
  const cursor = new Date(dtIni);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor <= dtFim) {
    const proximoDia = new Date(cursor);
    proximoDia.setUTCDate(proximoDia.getUTCDate() + 1);
    const inicioFatia = cursor < dtIni ? dtIni : cursor;
    const fimFatia = proximoDia > dtFim ? dtFim : proximoDia;
    const dow = cursor.getUTCDay(); // 0=dom, 6=sab
    if (dow !== 0 && dow !== 6) {
      const fracao = (fimFatia.getTime() - inicioFatia.getTime()) / (24 * 3600 * 1000);
      if (fracao > 0) totalDias += fracao;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Math.round(totalDias * 100) / 100;
}

function parseDataSsw(s: string): Date | null {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]) - 1;
  const yy = 2000 + Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  // Data brasileira (BRT = UTC-3). Convertendo pra UTC: soma 3h.
  return new Date(Date.UTC(yy, mm, dd, hh + 3, mi));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
