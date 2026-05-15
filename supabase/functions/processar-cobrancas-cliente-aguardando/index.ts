// =============================================================================
// processar-cobrancas-cliente-aguardando — cron diário (12:00 UTC).
//
// Pra cada card em AGUARDANDO_CLIENTE sem retorno do cliente:
//   - Se passaram ≥ 4 dias úteis desde o ÚLTIMO email outbound do card
//   - E cobranca_cliente_emails_enviados < 2
//   → dispara cobrar-cliente-aguardando modo=automatico.
//
// Disparo via HTTP interno (não chamando direto a função TS) pra centralizar
// lógica de envio em 1 lugar (cobrar-cliente-aguardando).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface CandidatoRow {
  card_id: string;
  nf: string | null;
  cobranca_count: number;
  ultima_atividade: string;
  dias_uteis_desde_ultima: number;
}

serve(async (_req) => {
  const env = Deno.env.toObject();
  const supabase = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Candidatos: query builder Supabase. RPC dias_uteis_entre filtra in-loop.
  // "Última atividade" = max(cobranca_cliente_ultima_em, último outbound).
  // Assim a 2ª cobrança espera 4 dias úteis APÓS a 1ª, não 8 após o outbound
  // original — semântica de "cobra de novo se ainda sem retorno".
  const candidatos: CandidatoRow[] = [];
  const { data: cardsAg } = await supabase
    .from("cards")
    .select("id, nf, cobranca_cliente_emails_enviados, cobranca_cliente_ultima_em")
    .eq("state", "AGUARDANDO_CLIENTE")
    .is("cliente_respondeu_em", null)
    .lt("cobranca_cliente_emails_enviados", 2);

  for (const c of (cardsAg ?? []) as Array<{
    id: string;
    nf: string | null;
    cobranca_cliente_emails_enviados: number;
    cobranca_cliente_ultima_em: string | null;
  }>) {
    const { data: ob } = await supabase
      .from("cards_emails_outbound")
      .select("sent_at")
      .eq("card_id", c.id)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastSent = (ob?.sent_at as string | null) ?? null;
    if (!lastSent) continue;

    const ultima = c.cobranca_cliente_ultima_em && c.cobranca_cliente_ultima_em > lastSent
      ? c.cobranca_cliente_ultima_em
      : lastSent;

    const { data: dias } = await supabase
      .rpc("dias_uteis_entre", { t1: ultima, t2: new Date().toISOString() });
    const diasNum = typeof dias === "number" ? dias : 0;
    if (diasNum >= 4) {
      candidatos.push({
        card_id: c.id,
        nf: c.nf,
        cobranca_count: c.cobranca_cliente_emails_enviados,
        ultima_atividade: ultima,
        dias_uteis_desde_ultima: diasNum,
      });
    }
  }

  // 2. Pra cada candidato, dispara cobrar-cliente-aguardando modo=automatico
  const sucessos: string[] = [];
  const falhas: Array<{ card_id: string; erro: string }> = [];
  for (const c of candidatos) {
    try {
      const r = await fetch(
        `${env["SUPABASE_URL"]}/functions/v1/cobrar-cliente-aguardando`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
            apikey: env["SUPABASE_SERVICE_ROLE_KEY"]!,
          },
          body: JSON.stringify({ card_id: c.card_id, modo: "automatico" }),
        },
      );
      const data = await r.json().catch(() => ({}));
      if (r.ok && (data as Record<string, unknown>).ok) {
        sucessos.push(c.card_id);
      } else {
        falhas.push({ card_id: c.card_id, erro: (data as { error?: string }).error ?? `HTTP ${r.status}` });
      }
    } catch (err) {
      falhas.push({ card_id: c.card_id, erro: err instanceof Error ? err.message : String(err) });
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      candidatos_total: candidatos.length,
      cobrancas_enviadas: sucessos.length,
      falhas: falhas.length,
      detalhes_falhas: falhas.slice(0, 10),
    }, null, 2),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
