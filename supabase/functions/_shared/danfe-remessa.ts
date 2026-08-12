// =============================================================================
// danfe-remessa — extração do Nº REMESSA (nº de delivery) da NF-e (SBD/Ingrid).
//
// Caio 2026-08-11 (onboarding Ingrid): a Black & Decker consulta romaneio na
// plataforma interna por NÚMERO DE DELIVERY (= "Nº Remessa"), não por NF. O
// número vive no campo DADOS ADICIONAIS da NF-e (ex.: "No Ordem de venda:
// 153681253 No Remessa: 1262024921").
//
// FONTE: XML da NF-e (link "XML NF" na tela 101 > DANFEs do SSW), campo
// <infAdic><infCpl>. O PDF do "Impr" NÃO serve: é imagem pura (JPEG embutido,
// DCTDecode — verificado 11/08 com o DANFE real da NF 23/002467883), texto
// inextraível sem OCR.
//
// Módulo PURO (regex/parse) — o fetch fica no ssw-internal-client.
// =============================================================================

/**
 * Extrai o Nº Remessa de um texto de Dados Adicionais.
 *
 * Âncora obrigatória na palavra "Remessa" — o mesmo campo carrega
 * "No Ordem de venda: NNN", que NUNCA pode casar. Aceita variações
 * "No Remessa", "Nº Remessa", "N. Remessa", "Nro Remessa", "Remessa:".
 */
export function extrairNumeroRemessa(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const m = texto.match(/\bN?[oº°.]?\s*Remessa\s*:?\s*(\d{6,20})\b/i);
  return m?.[1] ?? null;
}

/**
 * Extrai o conteúdo de <infCpl> (Dados Adicionais / informações complementares)
 * do XML da NF-e. Tolerante a namespace (<nfe:infCpl>) e a CDATA.
 * Também considera <infAdFisco> como fonte secundária.
 */
export function extrairDadosAdicionaisDoXmlNfe(xml: string | null | undefined): string | null {
  if (!xml) return null;
  const partes: string[] = [];
  for (const tag of ["infCpl", "infAdFisco"]) {
    const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "i"));
    if (m?.[1]) partes.push(m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1"));
  }
  if (partes.length === 0) return null;
  // entidades comuns em infCpl
  return partes.join(" ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#\d+;/g, " ");
}

/** Atalho: XML da NF-e → Nº Remessa (ou null). */
export function extrairNumeroRemessaDoXmlNfe(xml: string | null | undefined): string | null {
  return extrairNumeroRemessa(extrairDadosAdicionaisDoXmlNfe(xml));
}

/**
 * O SSW serve o XML da NF-e COMPACTADO (ZIP, content-type application/zip) —
 * validado ao vivo 2026-08-12 (NF 23/002467883 → No Remessa 1262026921).
 * Descompacta a 1ª entry *.xml com DecompressionStream nativo (deflate-raw),
 * sem dependência externa. Trata data-descriptor (compressed size = 0).
 */
export async function descompactarXmlDoZip(zip: Uint8Array): Promise<string | null> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let p = 0;
  while (p + 30 <= zip.length && dv.getUint32(p, true) === 0x04034b50) {
    const metodo = dv.getUint16(p + 8, true);
    let csize = dv.getUint32(p + 18, true);
    const fnlen = dv.getUint16(p + 26, true);
    const exlen = dv.getUint16(p + 28, true);
    const nome = new TextDecoder().decode(zip.slice(p + 30, p + 30 + fnlen));
    const inicio = p + 30 + fnlen + exlen;
    if (csize === 0) {
      // data-descriptor: dado vai até o próximo header (PK\x07\x08 ou PK\x01\x02)
      let e = inicio;
      while (e + 4 < zip.length && dv.getUint32(e, true) !== 0x08074b50 && dv.getUint32(e, true) !== 0x02014b50) e++;
      csize = e - inicio;
    }
    const dados = zip.slice(inicio, inicio + csize);
    if (/\.xml$/i.test(nome)) {
      if (metodo === 0) return new TextDecoder("utf-8").decode(dados); // stored
      return new TextDecoder("utf-8").decode(await inflateRaw(dados));
    }
    p = inicio + csize;
  }
  return null;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  // Via Blob→stream→DecompressionStream: evita o writer manual (e o atrito de
  // tipo Uint8Array<ArrayBufferLike> do Deno) e coleta o resultado de uma vez.
  // cast: o Deno tipa Uint8Array como <ArrayBufferLike>, mas Blob quer
  // <ArrayBuffer>; em runtime é o mesmo buffer.
  const stream = new Blob([bytes as unknown as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Desescapa entidades HTML aninhadas (a linha da tabela DANFES vem 2x escapada). */
export function desescaparHtml(s: string): string {
  const um = (t: string) =>
    t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  return um(um(s));
}

/** Extrai o href do link "XML NF-e" (ssw1188?id=...) da tela DANFES desescapada. */
export function extrairLinkXmlNfe(htmlDanfesDesescapado: string): string | null {
  return htmlDanfesDesescapado.match(/(https?:\/\/[^'"\s]*ssw1188[^'"\s]*)/i)?.[1] ?? null;
}

/**
 * Acha, no HTML de uma tela do SSW (detalhe 101 ou tela DANFEs), links cujo
 * texto/atributos casem com um rótulo (ex.: "DANFEs", "XML"). O SSW mistura
 * <a href>, <a onclick> e submits JS — devolvemos o alvo cru pra quem chamou
 * resolver contra a BASE. Defensivo por construção: a tela real será validada
 * ao vivo na fase de teste da branch (categorizar falha > adivinhar).
 */
export function extrairAlvosDeLink(
  html: string | null | undefined,
  rotulo: string,
): string[] {
  if (!html) return [];
  const alvos: string[] = [];
  const rxAncora = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const alvoRotulo = rotulo.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = rxAncora.exec(html)) !== null) {
    // rótulo visível = conteúdo sem as tags internas (<u>D</u>ANFEs → DANFEs)
    const label = (m[2] ?? "").replace(/<[^>]+>/g, "").trim().toLowerCase();
    if (!label.includes(alvoRotulo)) continue;
    const attrs = m[1] ?? "";
    // delimitador respeitado: onclick="abre('...')" tem aspas simples DENTRO
    const href = attrs.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i)?.slice(1).find(Boolean);
    const onclick = attrs.match(/onclick\s*=\s*(?:"([^"]*)"|'([^']*)')/i)?.slice(1).find(Boolean);
    // dentro do onclick, a URL costuma vir entre aspas simples
    const urlNoOnclick = onclick?.match(/'(\/?bin\/[^']+|https?:[^']+)'/)?.[1];
    const alvo = urlNoOnclick ?? (href && href !== "#" ? href : null) ?? onclick ?? null;
    if (alvo) alvos.push(alvo);
  }
  return alvos;
}

export type ResultadoRemessa =
  | { ok: true; remessa: string; via: "xml_nf" }
  | {
    ok: false;
    /** categoria estável pra evidência/auditoria */
    motivo:
      | "tela_danfes_nao_encontrada"
      | "xml_nao_encontrado"
      | "xml_nao_retornado_pelo_ssw"
      | "remessa_ausente_no_xml"
      | "erro_http";
    detalhe?: string;
  };
