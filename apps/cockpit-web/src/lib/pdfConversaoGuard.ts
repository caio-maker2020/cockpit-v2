// =============================================================================
// Guard da conversão PDF→JPEG (Caio 2026-07-17, NF 135724).
//
// pdf.js NÃO decodifica a camada JBIG2 de PDFs escaneados em modo "alta
// compressão" (MRC: fundo JPEG fraco + máscara JBIG2 com todo o texto preto) e
// ainda assim resolve o render como SUCESSO — a página sai quase em branco, só
// com o resíduo do fundo. Foi assim que a minuta da NF 135724 chegou quebrada
// no SSW. Medição 2026-07-17: ~6% dos PDFs inbound têm JBIG2; 4 de 5 testados
// quebraram de verdade — e um deles SEM warning nenhum no console.
//
// Por isso o veredito precisa de DOIS sinais (nenhum sozinho cobre tudo):
//   1. warning "Dependent image isn't ready yet" do pdf.js durante o render
//      (pegou 4/5 dos casos reais);
//   2. piso de pixels não-brancos — página de documento com <2% de conteúdo é
//      conversão perdida (pegou o caso que falha calado).
// =============================================================================

/** Fração mínima de pixels não-brancos pra considerar a página válida. */
export const PISO_PIXELS_NAO_BRANCOS = 0.02;

/** Warning que o pdf.js emite quando desiste de desenhar uma imagem dependente. */
export const RE_WARNING_PDFJS_IMG = /dependent image isn'?t ready/i;

export interface VereditoConversaoPagina {
  quebrada: boolean;
  motivo: "warning_pdfjs" | "pagina_quase_branca" | null;
  /** Fração (0..1) de pixels não-brancos medida no canvas. */
  fracaoNaoBranca: number;
}

/**
 * Avalia UMA página convertida. `data` é o ImageData.data (RGBA) do canvas já
 * renderizado; `warningDisparou` vem do hook de console.warn durante o render.
 * Pura — testável sem canvas real.
 */
export function avaliarPaginaConvertida(
  data: Uint8ClampedArray,
  warningDisparou: boolean,
  piso: number = PISO_PIXELS_NAO_BRANCOS,
): VereditoConversaoPagina {
  let naoBrancos = 0;
  const totalPx = Math.floor(data.length / 4);
  for (let i = 0; i + 2 < data.length; i += 4) {
    const r = data[i] ?? 255;
    const g = data[i + 1] ?? 255;
    const b = data[i + 2] ?? 255;
    if (r < 200 || g < 200 || b < 200) naoBrancos++;
  }
  const fracao = totalPx > 0 ? naoBrancos / totalPx : 0;
  if (warningDisparou) {
    return { quebrada: true, motivo: "warning_pdfjs", fracaoNaoBranca: fracao };
  }
  if (fracao < piso) {
    return { quebrada: true, motivo: "pagina_quase_branca", fracaoNaoBranca: fracao };
  }
  return { quebrada: false, motivo: null, fracaoNaoBranca: fracao };
}

/** Mensagem que o operador vê no toast (err.message do caller). */
export function mensagemConversaoQuebrada(
  filename: string,
  pagina: number,
  motivo: "warning_pdfjs" | "pagina_quase_branca",
): string {
  const causa = motivo === "warning_pdfjs"
    ? "o conversor não decodificou a camada de texto do scan"
    : "a página convertida ficou quase em branco";
  return `Página ${pagina} de "${filename}" perdeu o conteúdo na conversão (${causa}). ` +
    "Esse PDF é um scan em formato incompatível (JBIG2). " +
    "Contorno: tire um print/foto do documento e anexe como imagem JPEG.";
}
