// =============================================================================
// limite-anexos.ts — política do limite de anexos PENDENTES por card no
// upload manual do operador (edge `upload-anexo-email`).
//
// REGRA RAIZ (Caio 2026-06-23 — bug NF 719250 / Duilio): o limite existe pra
// bound o que o OPERADOR sobe e que vai pro SSW (`origem='outbound'`, default
// da coluna). Anexos `origem='inbound'` são AUTO-capturados dos e-mails do
// cliente — em geral imagens inline de assinatura/logo (image001.png 165 bytes,
// image002.jpg 4 KB, ...) + os PDFs do romaneio. Eles NÃO podem consumir o
// budget de upload do operador.
//
// Por que isto é a raiz e não um patch: a NF 719250 tinha 29 anexos pendentes,
// TODOS inbound (27 lixo de assinatura + 2 PDFs reais) e 0 outbound. Com o
// count contando inbound, 29 ≥ 20 → `upload-anexo-email` devolvia 400 em TODO
// upload novo — inclusive cada página JPEG convertida do PDF no browser. O
// supabase-js transforma 400 em "Edge Function returned a non-2xx status code"
// e o front rotulava "Falha ao converter PDF → JPEG". 18 cards estavam
// bloqueados pela mesma causa no momento do fix; todos destravam contando só
// outbound (nenhum tinha ≥ 20 outbound).
//
// Guard de não-regressão: INV-015 (docs/INVARIANTES_COCKPIT.md) + teste
// `_shared/limite-anexos.test.ts`. Se alguém remover o `.neq('origem',
// 'inbound')` da query, o teste e o INV quebram.
// =============================================================================

/** Teto de anexos PENDENTES (origem=outbound) que o operador pode ter por card. */
export const MAX_ANEXOS_UPLOAD_POR_CARD = 20;

/** Origens auto-capturadas que NÃO consomem o budget de upload do operador. */
export const ORIGENS_NAO_CONTABILIZADAS = new Set<string>(["inbound"]);

/** True se um anexo dessa `origem` conta pro limite de upload do operador. */
export function origemContaProLimite(origem: string | null | undefined): boolean {
  return !ORIGENS_NAO_CONTABILIZADAS.has((origem ?? "").trim());
}

// Tipo mínimo do client: só precisamos do `.from()`. O builder do supabase-js é
// chainável e thenable; tipamos o retorno do `.from()` como `any` (padrão do
// repo pra esses encadeamentos) e anotamos só o resultado final do await.
// deno-lint-ignore no-explicit-any
type SupabaseClientLike = { from(table: string): any };

/**
 * Constrói a query de contagem dos anexos PENDENTES que CONTAM pro limite de
 * upload do operador num card. Inbound é EXCLUÍDO de propósito (ver cabeçalho).
 *
 * NÃO remova o `.neq("origem", "inbound")` — é o coração do fix da NF 719250
 * (teste `limite-anexos.test.ts` + INV-015 quebram se sumir).
 */
export function queryAnexosQueContamProLimite(
  supabase: SupabaseClientLike,
  cardId: string,
): PromiseLike<{ count: number | null }> {
  return supabase
    .from("email_anexos")
    .select("*", { count: "exact", head: true })
    .eq("card_id", cardId)
    .neq("origem", "inbound") // inbound = auto-capturado (logos/assinaturas) → não consome budget
    .is("enviado_em", null)
    .is("deletado_em", null);
}

/** True quando a contagem (já filtrada por origem) atingiu o teto. */
export function limiteAnexosAtingido(qtdContabilizada: number | null | undefined): boolean {
  return (qtdContabilizada ?? 0) >= MAX_ANEXOS_UPLOAD_POR_CARD;
}

/** Mensagem de erro padrão quando o limite é atingido (deixa claro que inbound não conta). */
export function mensagemLimiteAtingido(): string {
  return `Limite de ${MAX_ANEXOS_UPLOAD_POR_CARD} anexos enviados por você neste card. ` +
    `Aprove/lance ou remova uploads pendentes antes de subir mais. ` +
    `(Anexos recebidos do cliente não contam pro limite.)`;
}
