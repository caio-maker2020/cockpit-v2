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

/**
 * IDs de anexos sugeridos pelo AGENTE no todo (meta.anexos_sugeridos, gravados
 * por _shared/anexos-33-sugeridos.ts — onda 2 do veto, Caio 25/08).
 */
export function anexosSugeridosDoTodo(
  propostaPayload: unknown,
): string[] {
  const meta = (propostaPayload as { meta?: { anexos_sugeridos?: unknown } } | null)?.meta;
  if (!Array.isArray(meta?.anexos_sugeridos)) return [];
  return (meta.anexos_sugeridos as Array<{ anexo_id?: unknown }>)
    .map((s) => (typeof s?.anexo_id === "string" ? s.anexo_id : null))
    .filter((x): x is string => !!x);
}

/**
 * Pré-seleção dos modais de oc 33 (onda 2 do veto): os anexos apontados pelo
 * agente vencem — mas SÓ os que existem no card E são suportados (INV-045
 * continua absoluto). Sem sugestão válida → primeiro suportado (como hoje).
 */
export function preSelecaoAnexos<T extends { id: string; mime_type: string | null }>(
  anexos: T[],
  sugeridosIA: readonly string[],
): string[] {
  const suportados = new Set(
    anexos.filter((a) => ehAnexoSuportadoSsw(a.mime_type)).map((a) => a.id),
  );
  const daIA = sugeridosIA.filter((id) => suportados.has(id));
  if (daIA.length > 0) return daIA;
  const primeiro = primeiroAnexoSuportadoSsw(anexos);
  return primeiro ? [primeiro] : [];
}
