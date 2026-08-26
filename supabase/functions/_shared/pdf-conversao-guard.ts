// =============================================================================
// pdf-conversao-guard (SERVIDOR) — port do guard NF-135724 do front
// (apps/cockpit-web/src/lib/pdfConversaoGuard.ts) pra conversão server-side
// com PDFium (Caio 26/08: "tudo que é PDF já ser regra converter").
//
// Diferença honesta vs o front: o sinal 1 (warning do pdf.js "dependent
// image isn't ready") NÃO existe aqui — o PDFium é o motor do Chrome e
// decodifica JBIG2 nativamente (a própria causa-raiz do NF-135724 não se
// aplica). Fica o sinal 2, universal: página de documento com <2% de pixels
// não-brancos = conversão perdida → NUNCA sobe pro SSW.
// Mesmo limiar do front (PISO_PIXELS_NAO_BRANCOS = 0.02) — mudou lá, muda cá.
// =============================================================================

/** Fração mínima de pixels não-brancos pra considerar a página válida. */
export const PISO_PIXELS_NAO_BRANCOS = 0.02;

export interface VereditoPaginaServidor {
  quebrada: boolean;
  motivo: "pagina_quase_branca" | null;
  fracaoNaoBranca: number;
}

/**
 * PURA: avalia UMA página renderizada (bytes RGBA ou BGRA — o critério
 * r/g/b<200 é simétrico à troca de canais, o alfa é ignorado).
 */
export function avaliarPaginaServidor(
  data: Uint8Array | Uint8ClampedArray,
  piso: number = PISO_PIXELS_NAO_BRANCOS,
): VereditoPaginaServidor {
  let naoBrancos = 0;
  const totalPx = Math.floor(data.length / 4);
  for (let i = 0; i + 2 < data.length; i += 4) {
    const r = data[i] ?? 255;
    const g = data[i + 1] ?? 255;
    const b = data[i + 2] ?? 255;
    if (r < 200 || g < 200 || b < 200) naoBrancos++;
  }
  const fracao = totalPx > 0 ? naoBrancos / totalPx : 0;
  if (fracao < piso) {
    return { quebrada: true, motivo: "pagina_quase_branca", fracaoNaoBranca: fracao };
  }
  return { quebrada: false, motivo: null, fracaoNaoBranca: fracao };
}
