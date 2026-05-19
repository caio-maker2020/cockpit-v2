// =============================================================================
// sync-kanban-status-prioridades — mantém cards.prioridades_kanban_status coerente
//
// Caio 2026-05-19 (PRIORIDADES AI):
// Cron 1×/dia (03h UTC). Lê v_oc21_aguardando_oc14 + v_oc13_paradas e seta:
//   - status NULL + card aparece em alguma view → 'parada'
//   - status NÃO NULL + card NÃO aparece em nenhuma view + sem efetividade
//     detectada pelo Monitor → mantém (monitor decide)
//
// NÃO faz transições parada→cobrado→escalado (isso é disparar-cobranca-
// escalonada). NÃO faz transição →resolvido (isso é o Monitor). É só
// bootstrap/housekeeping.
//
// Also: housekeeping — cards com kanban_status='resolvido' há >30 dias
// têm kanban_status zerado (some do kanban).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 1. Cards em v_oc21 ou v_oc13 com status NULL → 'parada'
    const { data: paradas21 } = await supabase
      .from("v_oc21_aguardando_oc14")
      .select("card_id");
    const { data: paradas13 } = await supabase
      .from("v_oc13_paradas")
      .select("card_id");

    const idsParadas = [
      ...(paradas21 ?? []).map((r) => (r as { card_id: string }).card_id),
      ...(paradas13 ?? []).map((r) => (r as { card_id: string }).card_id),
    ];
    const idsUnicos = [...new Set(idsParadas)];

    let bootstrapped = 0;
    if (idsUnicos.length > 0) {
      const { data: upd } = await supabase
        .from("cards")
        .update({
          prioridades_kanban_status: "parada",
          prioridades_kanban_atualizado_em: new Date().toISOString(),
        })
        .in("id", idsUnicos)
        .is("prioridades_kanban_status", null)
        .select("id");
      bootstrapped = (upd ?? []).length;
    }

    // 2. Housekeeping — cards 'resolvido' há >30 dias zeram
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: housekeep } = await supabase
      .from("cards")
      .update({
        prioridades_kanban_status: null,
        prioridades_kanban_atualizado_em: new Date().toISOString(),
      })
      .eq("prioridades_kanban_status", "resolvido")
      .lt("prioridades_kanban_atualizado_em", cutoff)
      .select("id");
    const housekept = (housekeep ?? []).length;

    return json({
      ok: true,
      bootstrapped,
      housekept,
      paradas_total: idsUnicos.length,
      paradas_oc21: (paradas21 ?? []).length,
      paradas_oc13: (paradas13 ?? []).length,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("sync-kanban-status-prioridades fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
