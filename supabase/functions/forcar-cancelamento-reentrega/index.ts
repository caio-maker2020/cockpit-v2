// =============================================================================
// forcar-cancelamento-reentrega — invocado pelo botão "Forçar agora" na aba
// "Cancelamentos Reentrega". Operador clica numa ação pendente/precisa_acao
// e dispara execução imediata (sem esperar próximo cron diário).
//
// Casos de uso:
//   1. Pós oc=21, operador quer cancelar AGORA sem esperar 24h (ex: já viu
//      no SSW que reentrega foi emitida mais rápido)
//   2. Falha "ctrc_faturado" → operador pediu Maisa pra excluir da fatura
//      → após confirmação, força nova tentativa
//   3. Qualquer status='precisa_acao' que o operador quer retentar
//
// Input: { acao_id: number }
// Output: { ok, status_novo, mensagem }
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

    const body = await req.json().catch(() => null) as { acao_id?: number } | null;
    if (!body?.acao_id || typeof body.acao_id !== "number") {
      return json({ ok: false, error: "acao_id obrigatório (number)" }, 400);
    }

    // 1. Valida que a ação existe e é do tipo correto
    const { data: acao, error: selErr } = await supabase
      .from("acoes_agendadas")
      .select("id, tipo, status, card_id, payload")
      .eq("id", body.acao_id)
      .maybeSingle();

    if (selErr) throw new Error(`SELECT acao: ${selErr.message}`);
    if (!acao) return json({ ok: false, error: "ação não encontrada" }, 404);
    if (acao.tipo !== "cancelar_reentrega_ssw") {
      return json({ ok: false, error: `tipo inválido: ${acao.tipo}` }, 400);
    }
    if (acao.status === "processado") {
      return json({ ok: false, error: "ação já foi processada com sucesso" }, 400);
    }
    if (acao.status === "tratado_manualmente") {
      return json({ ok: false, error: "ação já foi marcada como tratada manualmente" }, 400);
    }

    // 2. Reseta a ação pra rodar AGORA: status=pendente, executar_em=now,
    // mantém payload mas zera tentativas (operador quer tentar de novo do zero)
    const payloadAtual = (acao.payload ?? {}) as Record<string, unknown>;
    const novoPayload = {
      ...payloadAtual,
      tentativas: 0,
      ultima_falha: null,
      ultima_falha_em: null,
      forcado_em: new Date().toISOString(),
    };
    await supabase
      .from("acoes_agendadas")
      .update({
        status: "pendente",
        executar_em: new Date().toISOString(),
        processed_at: null,
        cancelado_motivo: null,
        payload: novoPayload,
      })
      .eq("id", acao.id);

    // 3. Registra evento de auditoria
    await supabase.from("card_events").insert({
      card_id: acao.card_id,
      event_type: "ReentregaCancelamentoForcadoPeloOperador",
      actor_type: "operator",
      actor_id: "forcar-cancelamento-reentrega",
      payload: {
        acao_id: acao.id,
        status_anterior: acao.status,
        forcado_em: new Date().toISOString(),
      },
    });

    // 4. Dispara handler imediatamente via HTTP (não espera cron)
    const handlerUrl = `${env["SUPABASE_URL"]}/functions/v1/processar-acoes-agendadas`;
    const r = await fetch(handlerUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
        apikey: env["SUPABASE_SERVICE_ROLE_KEY"]!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const handlerResp = await r.json().catch(() => null);

    // 5. Lê resultado final da ação
    const { data: acaoFinal } = await supabase
      .from("acoes_agendadas")
      .select("status, payload")
      .eq("id", acao.id)
      .single();

    return json({
      ok: true,
      status_novo: acaoFinal?.status ?? "desconhecido",
      mensagem: acaoFinal?.status === "processado"
        ? "Cancelamento gravado no SSW com sucesso"
        : acaoFinal?.status === "precisa_acao"
        ? `Falha definitiva: ${(acaoFinal?.payload as Record<string, unknown>)?.["ultima_falha"] ?? "?"}`
        : `Status: ${acaoFinal?.status}`,
      handler_summary: handlerResp,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
