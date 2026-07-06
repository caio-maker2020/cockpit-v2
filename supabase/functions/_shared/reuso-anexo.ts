// =============================================================================
// reuso-anexo — helpers PUROS pra re-busca/reuso de anexo inbound (Fase 2
// extravio parcial, NF 66193). O romaneio da 1ª resposta é apagado do bucket
// pós-envio (finalizarAnexosPosEnvio seta deletado_em + remove o arquivo). A 2ª
// oc 33 precisa dele de volta → re-baixa do e-mail e RESSUSCITA o registro.
//
// Funções puras, testadas em reuso-anexo.test.ts (convenção nº 8).
// =============================================================================

export type AcaoReupload = "pular_ativo" | "ressuscitar" | "upload_novo";

/**
 * Decide o que fazer com um anexo inbound (inbox+filename+size) dado os registros
 * existentes em email_anexos. A idempotência ANTIGA pulava por existência sem
 * olhar `deletado_em` → registro apagado (arquivo fora do bucket) fazia a 2ª oc 33
 * ficar sem arquivo. Agora:
 *   - existe registro ATIVO (deletado_em null) → pula (já disponível);
 *   - só existe registro DELETADO → RESSUSCITA (re-upload + novo registro ativo);
 *   - nenhum → upload novo.
 */
export function decidirReuploadAnexo(
  registros: ReadonlyArray<{ id: string; deletado_em: string | null }>,
): { acao: AcaoReupload; idAtivo: string | null } {
  const ativo = registros.find((r) => r.deletado_em == null);
  if (ativo) return { acao: "pular_ativo", idAtivo: ativo.id };
  if (registros.length > 0) return { acao: "ressuscitar", idAtivo: null };
  return { acao: "upload_novo", idAtivo: null };
}

/**
 * Entre os anexos DISPONÍVEIS (ativos) de uma mensagem, acha o que bate com a
 * referência do dossiê (filename obrigatório; size/mime confirmam se presentes).
 * Evita anexar o arquivo ERRADO quando a mensagem tem vários anexos.
 */
export function acharAnexoDoDossie(
  disponiveis: ReadonlyArray<{ id: string; filename: string; size_bytes: number; mime_type: string }>,
  ref: { filename?: string | null; size_bytes?: number | null; mime_type?: string | null },
): { id: string } | null {
  if (!ref.filename) return null;
  const fn = ref.filename.trim().toLowerCase();
  if (!fn) return null;
  const match = disponiveis.find((a) =>
    a.filename.toLowerCase() === fn &&
    (ref.size_bytes == null || a.size_bytes === ref.size_bytes) &&
    (ref.mime_type == null || a.mime_type.toLowerCase() === ref.mime_type.toLowerCase())
  );
  return match ? { id: match.id } : null;
}
