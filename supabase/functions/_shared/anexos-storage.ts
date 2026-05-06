// =============================================================================
// anexos-storage — helpers shared pra carregar anexos do bucket email_anexos
// e finalizar metadata pós-envio.
//
// Caio 2026-05-06: usado por executor (todos com email automático) e
// responder-email-cliente (resposta manual da aba RESPOSTA). Ambos chamam
// sendGmailMessage com attachments do mesmo formato.
// =============================================================================

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

export interface AnexoCarregado {
  filename: string;
  mime_type: string;
  content_base64: string;
  storage_path: string;
  meta_id: string;
}

/**
 * Baixa anexos do bucket email_anexos e retorna no formato de gmail-sender
 * (filename, mime_type, content_base64). Anexos não encontrados ou já
 * deletados são pulados silenciosamente — log pra debug.
 */
export async function carregarAnexosParaEnvio(
  supabase: SupabaseClient,
  anexoIds: string[],
): Promise<AnexoCarregado[]> {
  if (anexoIds.length === 0) return [];

  const { data: rows } = await supabase
    .from("email_anexos")
    .select("id, storage_path, filename, mime_type")
    .in("id", anexoIds)
    .is("deletado_em", null);

  const result: AnexoCarregado[] = [];
  for (const row of (rows ?? []) as Array<{
    id: string; storage_path: string; filename: string; mime_type: string;
  }>) {
    const { data: blob, error } = await supabase.storage
      .from("email_anexos")
      .download(row.storage_path);
    if (error || !blob) {
      console.warn(`anexo ${row.id} download falhou: ${error?.message ?? "blob null"}`);
      continue;
    }
    const arrBuf = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrBuf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    result.push({
      filename: row.filename,
      mime_type: row.mime_type,
      content_base64: b64,
      storage_path: row.storage_path,
      meta_id: row.id,
    });
  }
  return result;
}

/**
 * Pós-envio: deleta arquivos do bucket (privacidade — Caio 2026-05-06) e
 * marca enviado_em + deletado_em na metadata.
 */
export async function finalizarAnexosPosEnvio(
  supabase: SupabaseClient,
  anexos: Pick<AnexoCarregado, "storage_path" | "meta_id">[],
): Promise<void> {
  if (anexos.length === 0) return;
  const paths = anexos.map((a) => a.storage_path);
  const ids = anexos.map((a) => a.meta_id);
  const { error: storErr } = await supabase.storage
    .from("email_anexos")
    .remove(paths);
  if (storErr) {
    console.warn(`finalizarAnexos remove storage: ${storErr.message}`);
  }
  const now = new Date().toISOString();
  await supabase
    .from("email_anexos")
    .update({ enviado_em: now, deletado_em: now })
    .in("id", ids);
}
