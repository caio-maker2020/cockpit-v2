// =============================================================================
// upload-anexo-email — recebe upload de arquivo do frontend e guarda em
// storage.email_anexos. Retorna ID do anexo pra incluir no extras do
// aprovar_e_executar.
//
// Frontend chama com FormData: file + card_id (+ todo_id opcional).
// Auth: Bearer JWT do operador (authenticated). Service role pra escrita.
//
// Limites:
//   - 10MB por arquivo (validado aqui + bucket-level)
//   - 5 anexos por card (verifica antes de inserir)
//   - Tipos: PDF, imagens, Word, Excel, CSV, TXT (validado pelo bucket)
//
// Resposta: { ok: true, anexo_id, filename, size_bytes, mime_type }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { bloquearSeModoVisualizacao } from "../_shared/trava-visualizacao.ts";
import {
  limiteAnexosAtingido,
  mensagemLimiteAtingido,
  queryAnexosQueContamProLimite,
} from "../_shared/limite-anexos.ts";
import { sanitizarNomeArquivoParaStorageKey } from "../_shared/storage-key.ts";

const MAX_FILE_BYTES = 10 * 1024 * 1024;  // 10MB
// Limite de anexos PENDENTES por card: ver `_shared/limite-anexos.ts`.
// Caio 2026-05-22: limite 5 quebrava PDFs com >4 páginas (PDF inbound + N JPEGs
// convertidos somavam 6+). Subiu pra 20.
// Caio 2026-06-23 (bug NF 719250 / Duilio): o count contava `origem='inbound'`
// (assinaturas/logos inline auto-capturados do e-mail). Card com 29 inbound (0
// outbound) bloqueava 100% dos uploads — inclusive cada página JPEG do PDF
// convertido → front "Falha ao converter PDF → JPEG / non-2xx". Agora o count
// EXCLUI inbound (só conta o que o operador sobe). 18 cards estavam travados.

// Caio 2026-06-23 (bug Karol — NF 602277): o bucket email_anexos tem
// allowed_mime_types fechado. O browser NÃO é confiável pra detectar o MIME
// (`file.type` vem vazio em CSV/Excel, arquivos arrastados, etc.) e o código
// caía no fallback `application/octet-stream`, que o Storage rejeita com 415
// → 500 → front "Falha no upload". Fix: a EXTENSÃO do arquivo é a fonte
// autoritativa do content-type. Este mapa espelha EXATAMENTE o
// allowed_mime_types do bucket — qualquer extensão daqui sobe sem 415.
const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
};
const MIMES_PERMITIDOS = new Set(Object.values(EXT_TO_MIME));

/** Deriva content-type confiável: extensão manda; file.type só se já permitido. */
function resolverContentType(filename: string, browserType: string): string | null {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const porExtensao = EXT_TO_MIME[ext];
  if (porExtensao) return porExtensao;
  // Extensão desconhecida: aceita o tipo do browser só se estiver na whitelist.
  if (browserType && MIMES_PERMITIDOS.has(browserType)) return browserType;
  return null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Trava modo visualização (mig 324): gestor só-leitura (João/Isadora) não
  // executa; service_role e preflight passam direto (sem Authorization → null).
  {
    const travaAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const bloqueio = await bloquearSeModoVisualizacao(req, travaAdmin, corsHeaders);
    if (bloqueio) return bloqueio;
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResp({ ok: false, error: "Use POST" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResp({ ok: false, error: "ENV ausente" }, 500);
  }

  // Auth do operador
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonResp({ ok: false, error: "Authorization Bearer obrigatório" }, 401);
  }
  const userJwt = authHeader.slice(7);

  const supabaseAuth = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await supabaseAuth.auth.getUser(userJwt);
  if (userErr || !userData?.user) {
    return jsonResp({ ok: false, error: "Token inválido" }, 401);
  }
  const userId = userData.user.id;

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Resolve operador_id pelo user_id
  const { data: opRow } = await supabase
    .from("operadores")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  const operadorId = (opRow as { id?: string } | null)?.id;
  if (!operadorId) {
    return jsonResp({ ok: false, error: "Operador não encontrado" }, 403);
  }

  // Lê multipart/form-data
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return jsonResp({ ok: false, error: "Body deve ser multipart/form-data" }, 400);
  }

  const file = formData.get("file");
  const cardId = formData.get("card_id");
  const todoId = formData.get("todo_id");

  if (!(file instanceof File)) {
    return jsonResp({ ok: false, error: "campo 'file' ausente ou inválido" }, 400);
  }
  if (typeof cardId !== "string" || !cardId) {
    return jsonResp({ ok: false, error: "campo 'card_id' ausente" }, 400);
  }

  if (file.size > MAX_FILE_BYTES) {
    return jsonResp({
      ok: false,
      error: `Arquivo excede 10MB (recebido: ${(file.size / 1024 / 1024).toFixed(1)}MB)`,
    }, 400);
  }

  // Verifica limite de anexos por card. Conta SÓ os uploads do operador
  // (origem != 'inbound') — anexos inbound são auto-capturados do e-mail do
  // cliente (logos/assinaturas inline) e não consomem o budget. Ver
  // `_shared/limite-anexos.ts` + INV-015 (bug NF 719250).
  const { count } = await queryAnexosQueContamProLimite(supabase, cardId);

  if (limiteAnexosAtingido(count)) {
    return jsonResp({ ok: false, error: mensagemLimiteAtingido() }, 400);
  }

  // Content-type confiável pela extensão (não pelo file.type do browser, que
  // vem vazio e o bucket rejeita com 415). Tipo não suportado → 400 claro,
  // ANTES de tocar no Storage (não vira mais 500 opaco "Falha no upload").
  const contentType = resolverContentType(file.name, file.type);
  if (!contentType) {
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    return jsonResp({
      ok: false,
      error: `Tipo de arquivo não suportado${ext ? ` (.${ext})` : ""}. Aceitos: PDF, JPG, PNG, GIF, WEBP, Word (.doc/.docx), Excel (.xls/.xlsx), CSV e TXT. Fotos de iPhone (.heic) precisam ser convertidas para JPG/PNG antes de anexar.`,
    }, 400);
  }

  // Path no bucket: card_id/uuid/filename
  // O nome vai sanitizado por ALLOWLIST (ver _shared/storage-key.ts). Blocklist
  // antiga (`/[\r\n"\\/]/`) deixava passar `[ ] # % { }` etc. e o Storage
  // rejeitava a key com "Invalid key" (bug Isa/Karol NF 924 — `...SEP[1]...pdf`).
  const anexoId = crypto.randomUUID();
  const safeFilename = sanitizarNomeArquivoParaStorageKey(file.name);
  const storagePath = `${cardId}/${anexoId}/${safeFilename}`;

  // Upload pro bucket
  const arrayBuffer = await file.arrayBuffer();
  const { error: upErr } = await supabase.storage
    .from("email_anexos")
    .upload(storagePath, arrayBuffer, {
      contentType,
      upsert: false,
    });

  if (upErr) {
    console.error(`upload-anexo-email: Storage falhou (card=${cardId}, file=${safeFilename}, ct=${contentType}): ${upErr.message}`);
    return jsonResp({
      ok: false,
      error: `Upload Storage falhou: ${upErr.message}`,
    }, 500);
  }

  // Registra metadata
  const { data: meta, error: metaErr } = await supabase
    .from("email_anexos")
    .insert({
      id: anexoId,
      card_id: cardId,
      todo_id: typeof todoId === "string" && todoId ? todoId : null,
      uploaded_by: operadorId,
      storage_path: storagePath,
      filename: safeFilename,
      mime_type: contentType,
      size_bytes: file.size,
    })
    .select("id, filename, mime_type, size_bytes, uploaded_at")
    .single();

  if (metaErr) {
    // Rollback: tenta deletar do bucket
    await supabase.storage.from("email_anexos").remove([storagePath]).catch(() => {});
    console.error(`upload-anexo-email: INSERT email_anexos falhou (card=${cardId}): ${metaErr.message}`);
    return jsonResp({
      ok: false,
      error: `INSERT email_anexos falhou: ${metaErr.message}`,
    }, 500);
  }

  return jsonResp({
    ok: true,
    anexo_id: (meta as { id: string }).id,
    filename: (meta as { filename: string }).filename,
    mime_type: (meta as { mime_type: string }).mime_type,
    size_bytes: (meta as { size_bytes: number }).size_bytes,
    uploaded_at: (meta as { uploaded_at: string }).uploaded_at,
  }, 200);
});

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
