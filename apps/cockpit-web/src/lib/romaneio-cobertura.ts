// Cobertura do romaneio do dossiê pelos anexos escolhidos no modal oc33.
// ESPELHO de supabase/functions/_shared/romaneio-cobertura.ts — mudar nos dois.
// Auditoria 25/07 (NF 158084): confirmar sem o romaneio (ou só com assinatura)
// fazia o executor reverter em loop — o modal agora barra ANTES.

export function baseConvertidaDoPdf(filename: string): string {
  return filename.replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "_");
}

export function anexosCobremRomaneio(
  filenamesSelecionados: ReadonlyArray<string | null | undefined>,
  romaneioFilename: string | null | undefined,
): boolean {
  if (!romaneioFilename) return false;
  const alvo = romaneioFilename.toLowerCase();
  const base = baseConvertidaDoPdf(romaneioFilename).toLowerCase();
  return filenamesSelecionados.some((f) => {
    const fl = (f ?? "").toLowerCase();
    if (!fl) return false;
    if (fl === alvo) return true;
    return base.length > 0 && fl.startsWith(base) && /_p\d+\.jpe?g$/.test(fl);
  });
}

/** Romaneio exigido pelo dossiê de extravio parcial (fonte=anexo), se houver. */
export function romaneioExigidoDoCard(card: {
  agent_state?: Record<string, unknown> | null;
}): { filename: string; mime_type: string | null } | null {
  const ep = card.agent_state?.["extravio_parcial"] as
    | { caso?: string; dossie?: { romaneio?: { presente?: boolean; fonte?: string; filename?: string | null; mime_type?: string | null } } }
    | undefined;
  if (!ep || (ep.caso !== "1" && ep.caso !== "2")) return null;
  const r = ep.dossie?.romaneio;
  if (!r?.presente || r.fonte !== "anexo" || !r.filename) return null;
  return { filename: r.filename, mime_type: r.mime_type ?? null };
}
