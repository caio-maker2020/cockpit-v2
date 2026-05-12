// =============================================================================
// backfill-anexos-inbound — Pra mensagens inbound JÁ capturadas em
// messages_inbox que tinham anexos no Gmail mas foram ignorados (antes do
// fix Caio 2026-05-12). Refazz extrairAnexos + baixarAttachment + upload
// pro bucket + INSERT email_anexos com origem='inbound'.
//
// Input: { message_inbox_id } OU { card_id } (processa TODAS mensagens
//        inbound desse card que ainda não têm anexos linkados)
// Output: { ok, processadas, anexos_criados, summaries }
//
// Idempotente — se um attachmentId já tem linha em email_anexos pra essa
// mensagem, pula. Storage upload usa path único (UUID).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { extrairAnexos, baixarAttachment, getMensagemFull } from "../_shared/gmail-reader.ts";
import { loadOperadorGmailCreds, refreshGmailAccessToken } from "../_shared/gmail-sender.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANEXO_MAX_BYTES = 10 * 1024 * 1024;
const MIMES_PERMITIDOS = new Set([
  "application/pdf",
  "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv", "text/plain",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST esperado" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "SUPABASE env ausente" }, 500);

  let body: { message_inbox_id?: string; card_id?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: "JSON inválido" }, 400); }
  if (!body.message_inbox_id && !body.card_id) {
    return json({ ok: false, error: "message_inbox_id OU card_id obrigatório" }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Lista mensagens alvo
  let query = supabase
    .from("messages_inbox")
    .select("id, card_id, raw_payload")
    .eq("canal", "email");
  if (body.message_inbox_id) query = query.eq("id", body.message_inbox_id);
  else query = query.eq("card_id", body.card_id!);
  const { data: msgsRaw, error: selErr } = await query;
  if (selErr) return json({ ok: false, error: `SELECT messages_inbox: ${selErr.message}` }, 500);
  const msgs = (msgsRaw ?? []) as Array<{ id: string; card_id: string | null; raw_payload: Record<string, unknown> }>;
  if (msgs.length === 0) return json({ ok: false, error: "Nenhuma mensagem encontrada" }, 404);

  const summaries: Array<Record<string, unknown>> = [];
  let totalAnexos = 0;

  for (const msgInbox of msgs) {
    const gmailMessageId = msgInbox.raw_payload?.["gmail_message_id"] as string | undefined;
    const operadorId = msgInbox.raw_payload?.["operador_id"] as string | undefined;
    if (!gmailMessageId || !operadorId) {
      summaries.push({ message_inbox_id: msgInbox.id, skip: "sem gmail_message_id/operador_id" });
      continue;
    }
    if (!msgInbox.card_id) {
      summaries.push({ message_inbox_id: msgInbox.id, skip: "sem card_id" });
      continue;
    }

    try {
      const creds = await loadOperadorGmailCreds(supabase, operadorId);
      if (!creds) {
        summaries.push({ message_inbox_id: msgInbox.id, error: "sem creds Gmail" });
        continue;
      }
      const accessToken = await refreshGmailAccessToken(supabase, operadorId, creds);
      const fullMsg = await getMensagemFull(accessToken, gmailMessageId);
      const anexos = extrairAnexos(fullMsg);

      if (anexos.length === 0) {
        summaries.push({ message_inbox_id: msgInbox.id, anexos: 0 });
        continue;
      }

      const salvos: Array<{ id: string; filename: string }> = [];
      for (const anexo of anexos) {
        if (anexo.sizeBytes > ANEXO_MAX_BYTES) {
          summaries.push({ message_inbox_id: msgInbox.id, skip: `anexo ${anexo.filename} > 10MB` });
          continue;
        }
        if (!MIMES_PERMITIDOS.has(anexo.mimeType.toLowerCase())) {
          summaries.push({ message_inbox_id: msgInbox.id, skip: `mime ${anexo.mimeType} fora allowlist` });
          continue;
        }
        // Idempotência: pula se já existe linha pra essa msg+filename
        const { data: existente } = await supabase
          .from("email_anexos")
          .select("id")
          .eq("message_inbox_id", msgInbox.id)
          .eq("filename", anexo.filename)
          .maybeSingle();
        if (existente) {
          salvos.push({ id: (existente as { id: string }).id, filename: anexo.filename });
          continue;
        }

        const bytes = await baixarAttachment(accessToken, gmailMessageId, anexo.attachmentId);
        const anexoUuid = crypto.randomUUID();
        const safeFilename = anexo.filename.replace(/[^\w.\- ]/g, "_");
        const storagePath = `inbound/${msgInbox.id}/${anexoUuid}-${safeFilename}`;
        const { error: upErr } = await supabase.storage
          .from("email_anexos")
          .upload(storagePath, bytes, { contentType: anexo.mimeType, upsert: false });
        if (upErr) {
          summaries.push({ message_inbox_id: msgInbox.id, error: `upload ${anexo.filename}: ${upErr.message}` });
          continue;
        }
        const { data: anexoRow, error: insErr } = await supabase
          .from("email_anexos")
          .insert({
            card_id: msgInbox.card_id,
            origem: "inbound",
            message_inbox_id: msgInbox.id,
            storage_path: storagePath,
            filename: anexo.filename,
            mime_type: anexo.mimeType,
            size_bytes: bytes.byteLength,
          })
          .select("id")
          .single();
        if (insErr) {
          summaries.push({ message_inbox_id: msgInbox.id, error: `INSERT ${anexo.filename}: ${insErr.message}` });
          continue;
        }
        salvos.push({ id: (anexoRow as { id: string }).id, filename: anexo.filename });
      }

      totalAnexos += salvos.length;
      summaries.push({ message_inbox_id: msgInbox.id, anexos_salvos: salvos });
    } catch (err) {
      summaries.push({ message_inbox_id: msgInbox.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return json({
    ok: true,
    processadas: msgs.length,
    anexos_criados: totalAnexos,
    summaries,
  }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
