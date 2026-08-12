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
