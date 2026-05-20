// =============================================================================
// whatsapp-instance-status — lê estado atual do pareamento na Evolution e
// sincroniza com operadores.whatsapp_status. Frontend faz polling após QR.
//
// Caio 2026-05-20: complemento de criar-instancia-whatsapp.
//
// Input:  { operador_id: uuid }
// Output: { ok, instance, state, synced_at }
//
// state ∈ { open=pareado | connecting=QR pendente | close=desconectado |
//           unknown=Evolution não retornou conhecido }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  readEvolutionGlobal,
  connectionStateEvolution,
} from "../_shared/evolution-outbound.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface InputBody {
  operador_id?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let body: InputBody = {};
  try {
    body = (await req.json()) as InputBody;
  } catch {
    return jsonResp({ ok: false, error: "JSON inválido" }, 400);
  }

  const operadorId = body.operador_id?.trim();
  if (!operadorId) {
    return jsonResp({ ok: false, error: "operador_id obrigatório" }, 400);
  }

  const env = Deno.env.toObject();
  const supabase = createClient(
    env.SUPABASE_URL!,
    env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: operador, error: opErr } = await supabase
    .from("operadores")
    .select("id, whatsapp_instance")
    .eq("id", operadorId)
    .maybeSingle();

  if (opErr) return jsonResp({ ok: false, error: opErr.message }, 500);
  if (!operador) {
    return jsonResp({ ok: false, error: "operador não encontrado" }, 404);
  }
  if (!operador.whatsapp_instance) {
    return jsonResp(
      {
        ok: false,
        error: "operador ainda não tem instance criada",
        hint: "rodar /functions/v1/criar-instancia-whatsapp antes",
      },
      400,
    );
  }

  let global;
  try {
    global = readEvolutionGlobal(env);
  } catch (e) {
    return jsonResp(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      503,
    );
  }

  let state: string;
  try {
    const res = await connectionStateEvolution(global, operador.whatsapp_instance);
    state = res.state;
  } catch (e) {
    return jsonResp(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      502,
    );
  }

  const syncedAt = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("operadores")
    .update({ whatsapp_status: state, whatsapp_synced_at: syncedAt })
    .eq("id", operadorId);

  if (updErr) {
    return jsonResp({ ok: false, error: updErr.message }, 500);
  }

  return jsonResp({
    ok: true,
    instance: operador.whatsapp_instance,
    state,
    synced_at: syncedAt,
  });
});
