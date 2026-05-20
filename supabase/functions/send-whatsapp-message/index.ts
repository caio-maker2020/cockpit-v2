// =============================================================================
// send-whatsapp-message — envia 1 mensagem WhatsApp via instance do operador.
//
// Caio 2026-05-20: ação outbound primitiva. Caso de uso atual: cobrança manual
// de NFs que não seguiram pra entrega (oc 13/21). Caso futuro: cobrança
// autônoma agendada por cron.
//
// Input:
//   {
//     operador_id?:    uuid,
//     operador_nome?:  string,        // alternativa a operador_id
//     telefone:        string,        // qualquer formato — normalizado interno
//     mensagem:        string,
//     card_id?:        uuid,          // se for cobrança vinculada a um card
//     nf_referencia?:  string,        // texto livre pra audit (ex: NF 12345)
//     actor_type?:     'operator' | 'agent' | 'system',  // default 'operator'
//     actor_id?:       string         // user_id ou nome do agente
//   }
//
// Output:
//   { ok, message_id, audit_id, instance, deduped? }
//
// Idempotência:
//   audit_log.idempotency_key = whatsapp:<operador_id>:<phone>:<sha1(texto|card)>
//   UNIQUE no DB → reenvio do mesmo payload é detectado e devolvido como
//   { deduped: true, audit_id: <id existente> } sem disparar Evolution.
//   Reset natural: mudar 1 char no texto → nova key, novo envio.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  evolutionEnvFromInstance,
  enviarWhatsApp,
  normalizarTelefoneEvolution,
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

async function sha1(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface InputBody {
  operador_id?: string;
  operador_nome?: string;
  telefone?: string;
  mensagem?: string;
  card_id?: string;
  nf_referencia?: string;
  actor_type?: "operator" | "agent" | "system";
  actor_id?: string;
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

  const telefone = body.telefone?.trim();
  const mensagem = body.mensagem?.trim();
  if (!telefone) return jsonResp({ ok: false, error: "telefone obrigatório" }, 400);
  if (!mensagem) return jsonResp({ ok: false, error: "mensagem obrigatória" }, 400);
  if (!body.operador_id && !body.operador_nome) {
    return jsonResp({ ok: false, error: "operador_id OU operador_nome obrigatório" }, 400);
  }

  const env = Deno.env.toObject();
  const supabase = createClient(
    env.SUPABASE_URL!,
    env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // 1. Resolver operador + instance
  const sel = supabase
    .from("operadores")
    .select("id, nome, ativo, whatsapp_instance, whatsapp_status");
  const { data: operador, error: opErr } = await (body.operador_id
    ? sel.eq("id", body.operador_id)
    : sel.ilike("nome", body.operador_nome!)
  ).maybeSingle();

  if (opErr) return jsonResp({ ok: false, error: opErr.message }, 500);
  if (!operador) return jsonResp({ ok: false, error: "operador não encontrado" }, 404);
  if (!operador.ativo) return jsonResp({ ok: false, error: "operador inativo" }, 400);
  if (!operador.whatsapp_instance) {
    return jsonResp(
      {
        ok: false,
        error: "operador sem instance WhatsApp criada",
        hint: "rodar /functions/v1/criar-instancia-whatsapp",
      },
      400,
    );
  }
  if (operador.whatsapp_status && operador.whatsapp_status !== "open") {
    return jsonResp(
      {
        ok: false,
        error: `instance não pareada (state=${operador.whatsapp_status})`,
        instance: operador.whatsapp_instance,
        hint: "rodar /functions/v1/whatsapp-instance-status pra refresh ou refazer pareamento",
      },
      409,
    );
  }

  // 2. Idempotency key
  const phoneNorm = normalizarTelefoneEvolution(telefone);
  const hashInput = `${mensagem}|${body.card_id ?? ""}|${body.nf_referencia ?? ""}`;
  const digest = (await sha1(hashInput)).slice(0, 16);
  const idempotencyKey = `whatsapp:${operador.id}:${phoneNorm}:${digest}`;

  // 3. Checar duplicata (audit_log.idempotency_key UNIQUE)
  const { data: dup } = await supabase
    .from("audit_log")
    .select("id, external_id, status")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (dup) {
    return jsonResp({
      ok: true,
      deduped: true,
      audit_id: dup.id,
      message_id: dup.external_id,
      instance: operador.whatsapp_instance,
      status: dup.status,
    });
  }

  // 4. Enviar via Evolution
  let evEnv;
  try {
    evEnv = evolutionEnvFromInstance(env, operador.whatsapp_instance);
  } catch (e) {
    return jsonResp(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      503,
    );
  }

  let messageId = "";
  let rawResponse: unknown = null;
  let status: "success" | "failed" = "success";
  let errorMsg: string | null = null;

  try {
    const r = await enviarWhatsApp(evEnv, telefone, mensagem);
    messageId = r.messageId;
    rawResponse = r.rawResponse;
  } catch (e) {
    status = "failed";
    errorMsg = e instanceof Error ? e.message : String(e);
    rawResponse = { error: errorMsg };
  }

  // 5. INSERT audit_log (sempre — sucesso ou falha)
  const auditPayload = {
    card_id: body.card_id ?? null,
    action_type: "whatsapp_outbound",
    actor_type: body.actor_type ?? "operator",
    actor_id: body.actor_id ?? body.operador_id ?? operador.nome,
    external_system: "evolution" as const,
    idempotency_key: idempotencyKey,
    request_payload: {
      operador_id: operador.id,
      operador_nome: operador.nome,
      instance: operador.whatsapp_instance,
      telefone: phoneNorm,
      mensagem,
      card_id: body.card_id ?? null,
      nf_referencia: body.nf_referencia ?? null,
    },
    response_payload: rawResponse,
    status,
    external_id: status === "success" ? messageId || null : null,
  };

  const { data: audit, error: auditErr } = await supabase
    .from("audit_log")
    .insert(auditPayload)
    .select("id")
    .single();

  if (auditErr) {
    // Se foi falha de envio E falha de audit, devolve falha completa
    if (status === "failed") {
      return jsonResp(
        { ok: false, error: errorMsg, audit_error: auditErr.message },
        502,
      );
    }
    return jsonResp(
      {
        ok: false,
        error: `enviado mas falhou audit_log: ${auditErr.message}`,
        message_id: messageId,
      },
      500,
    );
  }

  if (status === "failed") {
    return jsonResp(
      {
        ok: false,
        error: errorMsg,
        audit_id: audit.id,
        instance: operador.whatsapp_instance,
      },
      502,
    );
  }

  return jsonResp({
    ok: true,
    message_id: messageId,
    audit_id: audit.id,
    instance: operador.whatsapp_instance,
  });
});
