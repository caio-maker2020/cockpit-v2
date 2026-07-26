// =============================================================================
// Cobertura do romaneio do dossiê pelos anexos escolhidos pelo operador.
//
// Auditoria 25/07 (NF 158084): o executor tratava QUALQUER anexo como
// "operador anexou" e pulava a materialização inteira — um PNG de assinatura
// lançava a oc 33 SEM o romaneio no SSW. A cobertura real é por filename:
// ou o próprio arquivo do romaneio (imagem), ou as páginas convertidas pelo
// modal (`<base>_pN.jpg`, nome derivado do PDF em convertPdfBlobToJpegFiles).
//
// ESPELHO: apps/cockpit-web/src/lib/romaneio-cobertura.ts — mudar nos dois.
// =============================================================================

/** Mesma derivação de nome do convertPdfBlobToJpegFiles do front. */
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
