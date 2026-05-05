// =============================================================================
// atualizar-card-via-tracking — botão "↻ atualizar agora" do card.
//
// Larissa clica no header do card → essa função consulta Bastão pendência +
// SSW tracking pra essa NF e aplica a regra de transição de AGUARDANDO_CLIENTE
// (mesma lógica do Pass E do sync-bastao). Útil quando ela não quer esperar
// o cron de 5min (ou quando Bastão acabou de atualizar e ela quer ver agora).
//
// Hoje só age em cards `state='AGUARDANDO_CLIENTE'`. Pra outros states, retorna
// `ok: true, no_action: true` com a info atual (Bastão+tracking) — Larissa vê
// que consultou mas nada precisava mudar.
//
// Input:  { card_id }
// Output: { ok, decisao, oc_bastao, oc_tracking, state_anterior, state_novo? }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createBastaoClient,
  readBastaoEnvFromProcess,
} from "../_shared/bastao-client.ts";
import {
  createSswTrackingClient,
  isTrackingSuccess,
  loadTrackingSenhasFromSupabase,
  readSswTrackingEnvFromProcess,
} from "../_shared/ssw-tracking-client.ts";
import {
  aplicarTransicaoAguardandoCliente,
  decidirTransicaoAguardandoCliente,
} from "../_shared/transicao-aguardando-cliente.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const body = await req.json().catch(() => ({}));
    const cardId: string | undefined = body.card_id;
    if (!cardId) return json({ ok: false, error: "card_id obrigatório" }, 400);

    const { data: card } = await supabase
      .from("cards")
      .select("id, nf, state, cod_ultima_ocorrencia, agent_state")
      .eq("id", cardId)
      .maybeSingle();
    if (!card) return json({ ok: false, error: "card não encontrado" }, 404);
    if (!card.nf) return json({ ok: false, error: "card sem NF" }, 400);

    const cnpjPagador = ((card.agent_state ?? {}) as Record<string, unknown>)["cnpj_pagador"] as string | undefined;
    const nf = String(card.nf).replace(/^0+/, "");

    // 1. Consulta Bastão pendência por NF
    const bastao = createBastaoClient({ env: readBastaoEnvFromProcess(env) });
    let ocBastao: number | null = null;
    try {
      const pend = await bastao.fetchPendenciaByNf(nf);
      ocBastao = pend?.cod_ultima_ocorrencia ?? null;
    } catch (err) {
      console.error("Bastão fetchPendenciaByNf:", err);
    }

    // 2. Consulta tracking SSW (se tem credencial pro CNPJ)
    let ocTracking: number | null = null;
    if (cnpjPagador) {
      try {
        const senhaByCnpj = await loadTrackingSenhasFromSupabase(supabase);
        const docLimpo = cnpjPagador.replace(/\D/g, "");
        if (senhaByCnpj[docLimpo]) {
          const ssw = createSswTrackingClient({
            env: { ...readSswTrackingEnvFromProcess(env), senhaByCnpj },
          });
          const resp = await ssw.fetchByNf(docLimpo, nf);
          if (isTrackingSuccess(resp)) {
            const tracking = (resp["tracking"] ?? []) as Array<Record<string, unknown>>;
            const last = tracking[tracking.length - 1];
            const ocStr = (last?.["ocorrencia"] as string | undefined) ?? "";
            const m = ocStr.match(/\((\d+)\)\s*$/);
            if (m) ocTracking = parseInt(m[1], 10);
          }
        }
      } catch (err) {
        console.error("Tracking fetchByNf:", err);
      }
    }

    // 3. Decide transição (só age em AGUARDANDO_CLIENTE; pra outros states
    // só retorna info pra UI mostrar)
    const stateAnterior = card.state as string;
    if (stateAnterior !== "AGUARDANDO_CLIENTE") {
      return json({
        ok: true,
        no_action: true,
        motivo: `card em state '${stateAnterior}' — atualização automática só atua em AGUARDANDO_CLIENTE`,
        oc_bastao: ocBastao,
        oc_tracking: ocTracking,
        state_atual: stateAnterior,
      }, 200);
    }

    const decisao = decidirTransicaoAguardandoCliente({ ocBastao, ocTracking });
    await aplicarTransicaoAguardandoCliente(
      supabase,
      cardId,
      card.cod_ultima_ocorrencia as number | null,
      decisao,
      "atualizar-card-via-tracking",
    );

    let stateNovo = stateAnterior;
    switch (decisao.tipo) {
      case "manter":
        stateNovo = "AGUARDANDO_CLIENTE";
        break;
      case "resolvido":
        stateNovo = "RESOLVIDO";
        break;
      case "aguardando_voce":
        stateNovo = "AGUARDANDO_VALIDACAO_HUMANA";
        break;
      case "tratativa_pendente":
        stateNovo = "TRATATIVA_PENDENTE";
        break;
      case "sem_info":
        stateNovo = stateAnterior;
        break;
    }

    return json({
      ok: true,
      decisao: decisao.tipo,
      oc_bastao: ocBastao,
      oc_tracking: ocTracking,
      state_anterior: stateAnterior,
      state_novo: stateNovo,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("atualizar-card-via-tracking fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
