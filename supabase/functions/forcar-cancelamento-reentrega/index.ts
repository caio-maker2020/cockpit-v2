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
    const body = await req.json().catch(() => null) as { acao_id?: number } | null;
    if (!body?.acao_id || typeof body.acao_id !== "number") {
      return json({ ok: false, error: "acao_id obrigatório (number)" }, 400);
    }

    // 1. Client COM JWT do usuário pra RPC validar acesso ao card via RLS.
    // Caio 2026-05-18: operador SÓ pode forçar cancelamento de cards da sua
    // carteira. RPC forcar_cancelamento_reentrega faz check de operador via
    // card_visivel_pelo_operador_atual (mesma função que a RLS de cards usa).
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUser = createClient(env["SUPABASE_URL"]!, env["SUPABASE_ANON_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { error: rpcErr } = await supabaseUser.rpc("forcar_cancelamento_reentrega", {
      p_acao_id: body.acao_id,
    });
    if (rpcErr) {
      // 42501 = sem permissão (operador errado). Outros = ação não existe ou estado inválido.
      const status = rpcErr.code === "42501" ? 403 : 400;
      return json({ ok: false, error: rpcErr.message }, status);
    }

    // 2. Após reset OK, dispara handler com service_role (precisa de RLS
    // bypass pra escrever em acoes_agendadas + chamar SSW interno).
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

    // 3. Lê resultado final via cliente service_role
    const supabaseService = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: acaoFinal } = await supabaseService
      .from("acoes_agendadas")
      .select("status, payload")
      .eq("id", body.acao_id)
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
