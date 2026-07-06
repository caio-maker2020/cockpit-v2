// =============================================================================
// reprocessar-anexos-mensagem — retroativo pra mensagens inbound que tiveram
// anexos ignorados pelo extrairAnexos antigo (regra de filtrar inline foi
// removida em 2026-05-29, mas mensagens já processadas antes do fix não
// foram re-extraídas).
//
// Input:
//   POST { gmail_message_id: string, operador_email?: string }
//   OU
//   POST { message_inbox_id: string }   // resolve operador via card
//
// Idempotente: pula anexos já presentes em email_anexos pra esse
// message_inbox_id (matching filename + size_bytes).
//
// Auth: service_role (Authorization: Bearer SUPABASE_SERVICE_ROLE_KEY)
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { extrairAnexos, selecionarAnexosParaSalvar, getMensagemFull, baixarAttachment } from "../_shared/gmail-reader.ts";
import { loadOperadorGmailCreds, refreshGmailAccessToken } from "../_shared/gmail-sender.ts";
import { decidirReuploadAnexo } from "../_shared/reuso-anexo.ts";

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResp({ ok: false, error: "POST esperado" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const body = await req.json().catch(() => ({})) as {
    gmail_message_id?: string;
    operador_email?: string;
    message_inbox_id?: string;
  };

  // Resolve message_inbox_id + gmail_message_id + card_id + operador_email
  let inboxId: string | null = null;
  let gmailMessageId: string | null = body.gmail_message_id ?? null;
  let cardId: string | null = null;
  let operadorEmail: string | null = body.operador_email ?? null;

  if (body.message_inbox_id) {
    // Fase 2 (Caio 2026-07-01): gmail_message_id/operador_id vivem em raw_payload
    // (jsonb) — messages_inbox NÃO tem essas colunas. Resolver daqui deixa o
    // caller (re-busca do romaneio) passar só o message_inbox_id.
    const { data, error } = await supabase
      .from("messages_inbox")
      .select("id, card_id, raw_payload")
      .eq("id", body.message_inbox_id)
      .maybeSingle();
    if (error || !data) return jsonResp({ ok: false, error: `messages_inbox não encontrada: ${error?.message ?? "row null"}` }, 404);
    inboxId = (data as { id: string }).id;
    cardId = (data as { card_id: string | null }).card_id;
    const rawPayload = ((data as { raw_payload?: Record<string, unknown> }).raw_payload ?? {});
    if (!gmailMessageId) gmailMessageId = (rawPayload["gmail_message_id"] as string | null) ?? null;
    if (!operadorEmail) operadorEmail = (rawPayload["operador_email"] as string | null) ?? null;
  }

  if (!gmailMessageId) return jsonResp({ ok: false, error: "gmail_message_id é obrigatório (direto ou via message_inbox_id)" }, 400);

  // Resolve operador
  const opQuery = supabase.from("operadores").select("id, email, gmail_oauth_credentials");
  const { data: ops } = operadorEmail
    ? await opQuery.eq("email", operadorEmail).limit(1)
    : await opQuery.not("gmail_oauth_credentials", "is", null).limit(1);
  const op = (ops?.[0] as { id: string; email: string; gmail_oauth_credentials: unknown } | undefined);
  if (!op) return jsonResp({ ok: false, error: "operador não encontrado (passe operador_email)" }, 404);

  const creds = await loadOperadorGmailCreds(supabase, op.id);
  if (!creds) return jsonResp({ ok: false, error: "operador sem creds Gmail" }, 400);

  const accessToken = await refreshGmailAccessToken(supabase, op.id, creds);

  const msg = await getMensagemFull(accessToken, gmailMessageId);
  if (!msg) return jsonResp({ ok: false, error: `Gmail message ${gmailMessageId} não encontrada` }, 404);

  // INV-025 (NF 1486931): mesma regra do gmail-poll-inbox — descarta imagem
  // embutida no corpo (assinatura) quando há anexo real na mensagem.
  const { salvar: anexos, ignorados: anexosInline } = selecionarAnexosParaSalvar(
    extrairAnexos(msg),
  );

  const resultado = {
    ok: true,
    gmail_message_id: gmailMessageId,
    message_inbox_id: inboxId,
    card_id: cardId,
    operador_email: op.email,
    anexos_encontrados: anexos.length,
    anexos_salvos: [] as Array<{ id: string; filename: string; mime: string; bytes: number }>,
    // Fase 2: TODOS os anexos inbound ATIVOS dessa mensagem (não só os salvos
    // agora) — o caller da re-busca filtra o romaneio certo por filename/size/mime.
    anexos_disponiveis: [] as Array<{ id: string; filename: string; size_bytes: number; mime_type: string }>,
    anexos_pulados: [
      ...anexosInline.map((a) => ({ filename: a.filename, motivo: "imagem inline do corpo (assinatura) + há anexo real — INV-025" })),
    ] as Array<{ filename: string; motivo: string }>,
  };

  for (const anexo of anexos) {
    if (anexo.sizeBytes > ANEXO_MAX_BYTES) {
      resultado.anexos_pulados.push({ filename: anexo.filename, motivo: `>${ANEXO_MAX_BYTES} bytes` });
      continue;
    }
    if (!MIMES_PERMITIDOS.has(anexo.mimeType.toLowerCase())) {
      resultado.anexos_pulados.push({ filename: anexo.filename, motivo: `mime ${anexo.mimeType} fora da allowlist` });
      continue;
    }

    // Idempotência (Fase 2): olha TODOS os registros (inclui deletados). Se há um
    // ATIVO → pula; se só há DELETADO (arquivo apagado pós-1ª oc 33) → RESSUSCITA
    // (re-upload). Antes o skip ignorava deletado_em → a 2ª oc 33 ficava sem arquivo.
    if (inboxId) {
      const { data: registros } = await supabase
        .from("email_anexos")
        .select("id, deletado_em")
        .eq("message_inbox_id", inboxId)
        .eq("filename", anexo.filename)
        .eq("size_bytes", anexo.sizeBytes);
      const decisao = decidirReuploadAnexo((registros ?? []) as Array<{ id: string; deletado_em: string | null }>);
      if (decisao.acao === "pular_ativo") {
        resultado.anexos_pulados.push({ filename: anexo.filename, motivo: "já existe ATIVO em email_anexos (idempotente)" });
        continue;
      }
      // ressuscitar / upload_novo → segue pro upload abaixo.
    }

    try {
      const bytes = await baixarAttachment(accessToken, gmailMessageId, anexo.attachmentId);
      const anexoUuid = crypto.randomUUID();
      const safeFilename = anexo.filename.replace(/[^\w.\- ]/g, "_");
      const storagePath = `inbound/${inboxId ?? "no-inbox"}/${anexoUuid}-${safeFilename}`;
      const { error: upErr } = await supabase.storage
        .from("email_anexos")
        .upload(storagePath, bytes, { contentType: anexo.mimeType, upsert: false });
      if (upErr) {
        resultado.anexos_pulados.push({ filename: anexo.filename, motivo: `upload falhou: ${upErr.message}` });
        continue;
      }
      const { data: anexoRow, error: insErr } = await supabase
        .from("email_anexos")
        .insert({
          card_id: cardId,
          origem: "inbound",
          message_inbox_id: inboxId,
          storage_path: storagePath,
          filename: anexo.filename,
          mime_type: anexo.mimeType,
          size_bytes: bytes.byteLength,
        })
        .select("id")
        .single();
      if (insErr) {
        resultado.anexos_pulados.push({ filename: anexo.filename, motivo: `INSERT email_anexos: ${insErr.message}` });
        continue;
      }
      resultado.anexos_salvos.push({
        id: (anexoRow as { id: string }).id,
        filename: anexo.filename,
        mime: anexo.mimeType,
        bytes: bytes.byteLength,
      });
    } catch (err) {
      resultado.anexos_pulados.push({
        filename: anexo.filename,
        motivo: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Card_event de auditoria
  if (cardId && resultado.anexos_salvos.length > 0) {
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "AnexosInboundReprocessados",
      actor_type: "system",
      actor_id: "reprocessar-anexos-mensagem",
      payload: {
        gmail_message_id: gmailMessageId,
        message_inbox_id: inboxId,
        anexos_salvos: resultado.anexos_salvos,
        anexos_pulados: resultado.anexos_pulados,
        motivo: "Retroativo do fix extrairAnexos (remoção do filtro inline) — Caio 2026-05-29",
      },
    });
  }

  // Fase 2: lista os anexos inbound ATIVOS dessa mensagem (recém-salvos +
  // pré-existentes não deletados) pro caller da re-busca filtrar o romaneio certo.
  if (inboxId) {
    const { data: ativos } = await supabase
      .from("email_anexos")
      .select("id, filename, size_bytes, mime_type")
      .eq("message_inbox_id", inboxId)
      .is("deletado_em", null);
    resultado.anexos_disponiveis = (ativos ?? []) as Array<{ id: string; filename: string; size_bytes: number; mime_type: string }>;
  }

  return jsonResp(resultado, 200);
});

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
