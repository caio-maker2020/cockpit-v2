// =============================================================================
// jpeg-sintetico — gera JPEG simples com texto centralizado.
// Usado pra evidência "romaneio não encontrado na plataforma interna" — Larissa
// aprovou Email+oc=33 mas a busca não achou. SSW exige imagem na oc=33, então
// geramos esse JPEG sintético como "print da busca".
//
// Caio 2026-05-12 (PRATI feature).
// =============================================================================

import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";

// Fonte TTF carregada lazy (1x por processo). Roboto Regular via jsdelivr
// (CDN estável com cache imutável + CORS habilitado).
const FONT_URL =
  "https://cdn.jsdelivr.net/fontsource/fonts/roboto@latest/latin-400-normal.ttf";

let cachedFont: Uint8Array | null = null;
async function carregarFonte(): Promise<Uint8Array> {
  if (cachedFont) return cachedFont;
  const res = await fetch(FONT_URL);
  if (!res.ok) {
    throw new Error(`Falha ao carregar fonte (${res.status})`);
  }
  cachedFont = new Uint8Array(await res.arrayBuffer());
  return cachedFont;
}

interface Linha {
  texto: string;
  escala: number;
}

const WIDTH = 800;
const HEIGHT = 600;
const COR_FUNDO = 0xffffffff; // branco
const COR_TEXTO = 0x111111ff; // quase-preto

async function desenharImagemTexto(linhas: Linha[]): Promise<Uint8Array> {
  const font = await carregarFonte();
  const img = new Image(WIDTH, HEIGHT).fill(COR_FUNDO);

  // Render cada linha como imagem temp
  const renderizadas: Image[] = [];
  for (const l of linhas) {
    const t = Image.renderText(font, l.escala, l.texto, COR_TEXTO);
    renderizadas.push(t);
  }

  // Compõe verticalmente centralizado
  const totalAltura = renderizadas.reduce((s, t) => s + t.height + 14, -14);
  let cursorY = Math.max(20, Math.floor((HEIGHT - totalAltura) / 2));
  for (const t of renderizadas) {
    const x = Math.max(0, Math.floor((WIDTH - t.width) / 2));
    img.composite(t, x, cursorY);
    cursorY += t.height + 14;
  }
  return await img.encodeJPEG(88);
}

function timestampBrtFormatado(ts: Date = new Date()): string {
  // Brasília UTC-3 (sem DST nessa janela)
  const brt = new Date(ts.getTime() - 3 * 60 * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(brt.getUTCDate())}/${pad(brt.getUTCMonth() + 1)}/${brt.getUTCFullYear()} ${pad(brt.getUTCHours())}:${pad(brt.getUTCMinutes())}`;
}

export async function gerarJpegRomaneioNaoEncontrado(
  nf: string,
  ts: Date = new Date(),
  // SBD/Ingrid 2026-08-11: quando a busca foi por Nº Remessa (delivery), a
  // evidência cita NF E remessa — é o "print" que a operação usa hoje.
  termoBusca?: string,
): Promise<Uint8Array> {
  const linhas = [
    { texto: "BUSCA EM PLATAFORMA INTERNA", escala: 36 },
    { texto: "SAL EXPRESS - ROMANEIO", escala: 28 },
    { texto: `NF ${nf}`, escala: 32 },
  ];
  if (termoBusca && termoBusca !== nf) {
    linhas.push({ texto: `No Remessa consultado: ${termoBusca}`, escala: 26 });
  }
  linhas.push(
    { texto: timestampBrtFormatado(ts), escala: 24 },
    { texto: "Nenhum documento localizado", escala: 32 },
  );
  return await desenharImagemTexto(linhas);
}

/**
 * SBD/Ingrid (2026-08-11): o Nº Remessa não pôde ser lido do DANFE/XML da
 * NF-e — a oc 33 sobe mesmo assim, com esta evidência (espelho do
 * "não encontrado", que é o processo atual).
 */
export async function gerarJpegRemessaNaoExtraida(
  nf: string,
  motivo: string,
  ts: Date = new Date(),
): Promise<Uint8Array> {
  return await desenharImagemTexto([
    { texto: "BUSCA EM PLATAFORMA INTERNA", escala: 36 },
    { texto: "SAL EXPRESS - ROMANEIO", escala: 28 },
    { texto: `NF ${nf}`, escala: 32 },
    { texto: timestampBrtFormatado(ts), escala: 24 },
    { texto: "No Remessa nao localizado no DANFE", escala: 28 },
    { texto: (motivo ?? "").slice(0, 60), escala: 20 },
  ]);
}

/**
 * Fase 2 (NF 66193): evidência da descrição/valor dos itens quando o texto não
 * cabe no campo Instrução do SSW (>500). Renderiza o texto ORIGINAL do cliente
 * (fonte, não paráfrase) numa imagem, pra subir como anexo na 2ª oc 33.
 */
export async function gerarJpegDescricaoValor(
  nf: string,
  textoCompleto: string,
  ts: Date = new Date(),
): Promise<Uint8Array> {
  const palavras = (textoCompleto ?? "").replace(/\s+/g, " ").trim().split(" ");
  const linhasTexto: string[] = [];
  let atual = "";
  for (const p of palavras) {
    if (`${atual} ${p}`.trim().length > 48) {
      if (atual) linhasTexto.push(atual);
      atual = p;
    } else {
      atual = `${atual} ${p}`.trim();
    }
  }
  if (atual) linhasTexto.push(atual);
  const corpo = linhasTexto.slice(0, 18).map((t) => ({ texto: t, escala: 20 }));
  return await desenharImagemTexto([
    { texto: "DESCRICAO E VALOR DOS ITENS", escala: 30 },
    { texto: `NF ${nf} - ${timestampBrtFormatado(ts)}`, escala: 22 },
    ...corpo,
  ]);
}

export async function gerarJpegErroPlataforma(
  nf: string,
  motivoErro: string,
  ts: Date = new Date(),
): Promise<Uint8Array> {
  return await desenharImagemTexto([
    { texto: "FALHA AO CONSULTAR", escala: 36 },
    { texto: "PLATAFORMA INTERNA", escala: 36 },
    { texto: `NF ${nf}`, escala: 28 },
    { texto: timestampBrtFormatado(ts), escala: 22 },
    { texto: motivoErro.slice(0, 60), escala: 20 },
  ]);
}
