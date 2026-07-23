// =============================================================================
// Elegibilidade de anexos pro SSW — FONTE ÚNICA (Caio 2026-07-23, NF 814961
// DUILIO). O SSW só aceita JPEG/PNG (PDFs são convertidos pra JPEG no modal).
//
// Bug de origem: os DOIS modais de oc=33 (solo e combo 33+44) pré-selecionavam
// o PRIMEIRO anexo do cliente sem olhar o tipo; arquivo não-suportado tinha o
// checkbox DESABILITADO (feito pra impedir marcar — mas também impedia
// DESMARCAR); a validação do confirmar bloqueava com "Remova: image001.gif".
// Marcado à força + impossível desmarcar + bloqueio = beco sem saída (gif de
// assinatura de e-mail como 1º anexo é comuníssimo).
//
// REGRA (INV-045): arquivo não-suportado fica FORA do universo de seleção —
// nunca é pré-selecionado, não tem checkbox (linha informativa), e a validação
// o IGNORA em vez de bloquear.
// =============================================================================

// Semântica IDÊNTICA às isImageMime/isPdfMime do ProposedActions (fonte da
// verdade histórica) — qualquer mudança tem que acontecer nos DOIS lugares
// até a unificação total dos call-sites.
export function ehImagemSsw(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return mime === "image/jpeg" || mime === "image/jpg" || mime === "image/png";
}

export function ehPdf(mime: string | null | undefined): boolean {
  return mime === "application/pdf";
}

/** Suportado = vai pro SSW direto (imagem) ou via conversão (PDF→JPEG). */
export function ehAnexoSuportadoSsw(mime: string | null | undefined): boolean {
  return ehImagemSsw(mime) || ehPdf(mime);
}

/**
 * Primeiro anexo SUPORTADO da lista (pra pré-seleção). null = nenhum
 * suportado → nada é pré-selecionado (operador segue com upload manual).
 */
export function primeiroAnexoSuportadoSsw<T extends { id: string; mime_type: string | null }>(
  anexos: T[],
): string | null {
  const el = anexos.find((a) => ehAnexoSuportadoSsw(a.mime_type));
  return el ? el.id : null;
}
