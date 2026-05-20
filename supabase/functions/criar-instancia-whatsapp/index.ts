// =============================================================================
// criar-instancia-whatsapp — provisiona instance Evolution pro operador alvo
// e devolve QR code base64 pra pareamento.
//
// Caio 2026-05-20: deploy Evolution API no Railway, multi-instance por operador.
// Cada operador no Cockpit recebe sua própria instance (= seu próprio número).
//
// Input:  { operador_id: uuid }
// Output: { ok, instance, qrcode_base64, pairing_code, state }
//
// Idempotente:
//   - Se operador já tem `whatsapp_instance` setado, chama /instance/connect
//     pra trazer QR atual (não cria duplicada).
//   - Se Evolution responder 403/409 (instance existe), também faz connect.
//
// Pareamento:
//   1. Frontend chama esta edge → recebe qrcode_base64
//   2. Renderiza <img src="data:image/png;base64,...">
//   3. Operador escaneia no WhatsApp do celular dele
//   4. Frontend faz polling em /whatsapp-instance-status até state="open"
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  readEvolutionGlobal,
  criarInstanceEvolution,
  slugOperador,
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

  // 1. Buscar operador
  const { data: operador, error: opErr } = await supabase
    .from("operadores")
    .select("id, nome, ativo, whatsapp_instance, whatsapp_status")
    .eq("id", operadorId)
    .maybeSingle();

  if (opErr) return jsonResp({ ok: false, error: opErr.message }, 500);
  if (!operador) {
    return jsonResp({ ok: false, error: "operador não encontrado" }, 404);
  }
  if (!operador.ativo) {
    return jsonResp({ ok: false, error: "operador inativo" }, 400);
  }

  // 2. Resolver/calcular nome da instance
  const instanceName: string =
    (operador.whatsapp_instance as string | null) ?? slugOperador(operador.nome);

  // 3. Chamar Evolution (idempotente via /instance/connect se já existir)
  let global;
  try {
    global = readEvolutionGlobal(env);
  } catch (e) {
    return jsonResp(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        hint: "Setar EVOLUTION_BASE_URL e EVOLUTION_GLOBAL_APIKEY",
      },
      503,
    );
  }

  let result;
  try {
    result = await criarInstanceEvolution(global, instanceName);
  } catch (e) {
    return jsonResp(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      502,
    );
  }

  // 4. Persistir instance no DB (UPSERT)
  const { error: updErr } = await supabase
    .from("operadores")
    .update({
      whatsapp_instance: instanceName,
      whatsapp_status: result.state ?? "connecting",
      whatsapp_synced_at: new Date().toISOString(),
    })
    .eq("id", operadorId);

  if (updErr) {
    return jsonResp(
      { ok: false, error: `update operadores falhou: ${updErr.message}` },
      500,
    );
  }

  return jsonResp({
    ok: true,
    instance: instanceName,
    qrcode_base64: result.qrcodeBase64,
    pairing_code: result.pairingCode,
    state: result.state ?? "connecting",
  });
});
