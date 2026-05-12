// =============================================================================
// voltar-para-to-do-com-rastreio
//
// Substitui a chamada direta da RPC `voltar_para_to_do` no frontend. Antes de
// finalizar o "voltar pra to-do", consulta SSW Tracking pra detectar oc real
// no SSW (que pode ser mais nova que o que está no banco). Se a oc real
// indica responsabilidade fora de Relacionamento (ex: oc=14 saiu pra entrega
// = Operação), atualiza o card direto pra TRANSFERIDO — evitando ciclo
// vicioso onde card volta pra to-do, próximo sync ainda lê Bastão
// desatualizado, e re-puxa pra AGUARDANDO_VALIDACAO_HUMANA.
//
// Sem credencial cadastrada pro pagador → fallback: chama a RPC sem rastreio
// (comportamento atual).
//
// Input: { todo_id, motivo? }
// Output: { ok, card_id, new_state, todos_cancelados, rastreio?: {...} }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createSswTrackingClient,
  isTrackingSuccess,
  loadTrackingSenhasFromSupabase,
  readSswTrackingEnvFromProcess,
} from "../_shared/ssw-tracking-client.ts";
import { clampOcAoDicionario } from "../_shared/safe-oc-update.ts";

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
    // Service role pra atualizar card direto sem RLS
    const supabaseSvc = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // Cliente "como user" pra chamar RPC voltar_para_to_do (que valida auth.uid())
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUser = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_ANON_KEY"]!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const body = await req.json().catch(() => ({}));
    const todoId: string | undefined = body.todo_id;
    const motivo: string | null = body.motivo ?? null;

    if (!todoId) {
      return json({ ok: false, error: "todo_id obrigatório" }, 400);
    }

    // 1. Carrega card via service role (precisa de cnpj_pagador, nf)
    const { data: todo } = await supabaseSvc
      .from("todos")
      .select("id, card_id")
      .eq("id", todoId)
      .maybeSingle();
    if (!todo) {
      return json({ ok: false, error: `todo ${todoId} não encontrado` }, 404);
    }

    const { data: card } = await supabaseSvc
      .from("cards")
      .select("id, nf, cod_ultima_ocorrencia, agent_state")
      .eq("id", todo.card_id)
      .maybeSingle();
    if (!card) {
      return json({ ok: false, error: `card ${todo.card_id} não encontrado` }, 404);
    }

    const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
    const cnpjPagador = (agentState["cnpj_pagador"] as string | undefined) ?? null;
    const nf = card.nf as string | null;
    const codAtualBanco = card.cod_ultima_ocorrencia as number | null;

    // 2. Tenta rastreio SSW se tem credencial e dados mínimos
    let rastreio: {
      tentado: boolean;
      sucesso: boolean;
      oc_real?: number;
      oc_banco?: number | null;
      mudou?: boolean;
      mensagem?: string;
    } = { tentado: false, sucesso: false };

    if (cnpjPagador && nf) {
      const senhaByCnpj = await loadTrackingSenhasFromSupabase(supabaseSvc);
      const documentoLimpo = cnpjPagador.replace(/\D/g, "");
      const temSenha = senhaByCnpj[documentoLimpo] !== undefined;

      if (temSenha) {
        rastreio.tentado = true;
        try {
          const ssw = createSswTrackingClient({
            env: { ...readSswTrackingEnvFromProcess(env), senhaByCnpj },
          });
          const resp = await ssw.fetchByNf(documentoLimpo, nf);
          if (isTrackingSuccess(resp)) {
            const tracking = (resp["tracking"] ?? []) as Array<Record<string, unknown>>;
            // Última oc é a do final do array (SSW devolve em ordem cronológica)
            const last = tracking[tracking.length - 1];
            const ocStr = (last?.["ocorrencia"] as string | undefined) ?? "";
            const match = ocStr.match(/\((\d+)\)\s*$/);
            if (match) {
              const ocReal = parseInt(match[1], 10);
              rastreio.sucesso = true;
              rastreio.oc_real = ocReal;
              rastreio.oc_banco = codAtualBanco;
              rastreio.mudou = ocReal !== codAtualBanco;
            } else {
              rastreio.mensagem = "Não foi possível extrair código da última oc";
            }
          } else {
            rastreio.mensagem = (resp as { message?: string })?.message ?? "tracking sem sucesso";
          }
        } catch (err) {
          rastreio.mensagem = err instanceof Error ? err.message : String(err);
        }
      } else {
        rastreio.mensagem = `Sem senha tracking pra CNPJ ${documentoLimpo}`;
      }
    }

    // 3. Chama RPC voltar_para_to_do (auth do operador → valida permissões)
    const { data: rpcData, error: rpcError } = await supabaseUser.rpc("voltar_para_to_do", {
      p_todo_id: todoId,
      p_motivo: motivo,
    });

    if (rpcError) {
      return json({ ok: false, error: `voltar_para_to_do: ${rpcError.message}` }, 500);
    }

    let finalState = (rpcData as Record<string, unknown>)?.["new_state"] as string | undefined;

    // 4. Se rastreio detectou oc diferente, atualiza card antes do retorno —
    //    state recalculado pelo dicionário (sem responsavel_atual fresh).
    if (rastreio.sucesso && rastreio.mudou && typeof rastreio.oc_real === "number") {
      const { data: novoState } = await supabaseSvc.rpc("state_pelo_bastao", {
        p_cod: rastreio.oc_real,
        p_responsavel_atual: null,
      });

      const stateRastreio = (typeof novoState === "string" ? novoState : null) ?? finalState ?? "AGUARDANDO_AGENTE";

      // Camada 2: oc do tracking pode ser >58 (SSWMOBILE). Clamp evita FK
      // violation. Se inválida, mantém a oc anterior do card.
      const ocSegura = await clampOcAoDicionario(
        supabaseSvc,
        rastreio.oc_real,
        codAtualBanco,
        "voltar-para-to-do-com-rastreio",
        card.id as string,
      );

      await supabaseSvc
        .from("cards")
        .update({
          cod_ultima_ocorrencia: ocSegura,
          state: stateRastreio,
          aviso_alteracao_oc: null,
        })
        .eq("id", card.id);

      await supabaseSvc.from("card_events").insert({
        card_id: card.id,
        event_type: "OcAtualizadaPorRastreioRT",
        actor_type: "system",
        actor_id: "voltar-para-to-do-com-rastreio",
        payload: {
          oc_anterior: codAtualBanco,
          oc_real: rastreio.oc_real,
          state_anterior: finalState,
          state_novo: stateRastreio,
          fonte: "ssw_tracking",
          motivo_voltar: motivo,
        },
      });

      finalState = stateRastreio;
    }

    return json({
      ok: true,
      card_id: card.id,
      new_state: finalState,
      todos_cancelados: (rpcData as Record<string, unknown>)?.["todos_cancelados"] ?? 0,
      rastreio,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("voltar-para-to-do-com-rastreio fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
