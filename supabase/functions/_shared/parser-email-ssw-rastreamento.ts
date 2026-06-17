// =============================================================================
// parser-email-ssw-rastreamento.ts
//
// Parser do e-mail automático de "Rastreamento de Cargas" que o SSW dispara
// (remetente sswemail@ssw.inf.br) ao cliente NO MOMENTO em que uma ocorrência
// é lançada — antes de a NF vencer prazo e aparecer no Bastão.
//
// Caio 2026-06-16/17: usado pelo ramo de criação antecipada de card no
// gmail-poll-inbox. Função PURA (testável). O corpo do e-mail do SSW é HTML
// (tabela rótulo→valor), então convertemos HTML→texto antes de extrair.
//
// Formato âncora (e-mail real ASTRAZENECA, 2026-06-16) — renderizado:
//   Remetente:      ASTRAZENECA DO BRASIL LTDA
//   Destinatário:   ANTONIO ERNESTO BARBIERI
//   Notas Fiscais:  2 279985, 2 279986       (números são links <a>)
//   Unidade:        VIANA / ES
//   Data e Hora:    16/06/26 16:10:49
//   Nova Situação:  000 000032482 - 06 EXTRAVIO DE MERCADORIA
//
// "Notas Fiscais: 2 279985": "2" é a SÉRIE e "279985" o NÚMERO da NF (um espaço
// só — não é separador de milhar). O número casa com cards.nf e com a busca
// interna do SSW (sem série, sem zeros à esquerda). `raw` guardado p/ auditoria.
// =============================================================================

export const REMETENTE_SSW = "sswemail@ssw.inf.br";

// Rótulos conhecidos do e-mail (em regex, tolerando acento). Usados como
// fronteiras: o valor de um rótulo vai até o PRÓXIMO rótulo (ou fim).
const LABELS_RE = [
  "Remetente",
  "Destinat[áa]rio",
  "Notas? Fisca(?:l|is)", // "Nota Fiscal" (singular) e "Notas Fiscais" (plural)
  "Pedido",
  "Unidade",
  "Data e Hora",
  "Nova Situa[çc][ãa]o",
  "Situa[çc][ãa]o",
  "Rastreamento",
  "Informa[çc][õo]es",
];
const STOP_ALT = LABELS_RE.join("|");
// Fronteira de valor: próximo rótulo "Label:" OU frases do rodapé (sem ":")
// OU fim. O rodapé ("Rastreamento completo", "Informações importantes") não tem
// ":" e precisa cortar o valor de "Nova Situação" — senão vaza o " - " do
// rodapé ("Informações importantes: - Para contatar...") e quebra o parse.
const STOP_BOUNDARY =
  `(?:(?:${STOP_ALT})\\s*:|Rastreamento\\s+completo|Informa[çc][õo]es\\s+importantes|$)`;

export interface NotaFiscalEmailSsw {
  raw: string; // token original, ex "2 279985"
  serie: string | null; // "2" quando há prefixo de série
  numero: string; // normalizado (sem série, sem zeros à esquerda), ex "279985"
}

export interface OcorrenciaEmailSsw {
  codigo: number | null; // ex 49
  descricao: string; // ex "EXTRAVIO DE MERCADORIA"
}

export interface EmailSswParsed {
  remetente: string | null;
  destinatario: string | null;
  unidade: string | null;
  dataHora: string | null; // raw "16/06/26 16:10:49"
  notas: NotaFiscalEmailSsw[];
  ocorrencia: OcorrenciaEmailSsw | null;
}

/** Decodifica entidades HTML comuns (PT) + numéricas. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&aacute;/gi, "á").replace(/&acirc;/gi, "â").replace(/&atilde;/gi, "ã").replace(/&agrave;/gi, "à")
    .replace(/&eacute;/gi, "é").replace(/&ecirc;/gi, "ê")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó").replace(/&ocirc;/gi, "ô").replace(/&otilde;/gi, "õ")
    .replace(/&uacute;/gi, "ú").replace(/&uuml;/gi, "ü")
    .replace(/&ccedil;/gi, "ç")
    .replace(/&Aacute;/g, "Á").replace(/&Eacute;/g, "É").replace(/&Iacute;/g, "Í").replace(/&Oacute;/g, "Ó").replace(/&Ccedil;/g, "Ç")
    .replace(/&#(\d+);/g, (_m, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return _m; }
    });
}

/**
 * HTML → texto plano. Remove style/script, troca tags por espaço, decodifica
 * entidades e colapsa espaços. Em texto puro é praticamente no-op.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    (html ?? "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Normaliza NF: só dígitos, sem zeros à esquerda (igual ao resto do Cockpit). */
export function normalizeNfEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, "");
  const semZeros = digits.replace(/^0+(?=\d)/, "");
  return semZeros.length > 0 ? semZeros : null;
}

/**
 * `from` do header é um e-mail do SSW de rastreamento?
 * Tolera "Sal Express <sswemail@ssw.inf.br>" e variações de caixa.
 */
export function ehRemetenteSsw(fromHeader: string | null | undefined): boolean {
  if (!fromHeader) return false;
  return fromHeader.toLowerCase().includes(REMETENTE_SSW);
}

/** Valor de "Label:" até o PRÓXIMO rótulo conhecido (ou fim). Texto já achatado. */
function valorDoRotulo(texto: string, rotulos: string[]): string | null {
  for (const rotulo of rotulos) {
    const re = new RegExp(
      `${rotulo}\\s*:\\s*([\\s\\S]*?)\\s*(?=${STOP_BOUNDARY})`,
      "i",
    );
    const m = texto.match(re);
    if (m && m[1] != null) {
      const v = m[1].trim();
      if (v.length > 0) return v;
    }
  }
  return null;
}

/** "2 279985, 2 279986" → [{raw,serie,numero}, ...] */
function parseNotasFiscais(valor: string | null): NotaFiscalEmailSsw[] {
  if (!valor) return [];
  const itens = valor.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const notas: NotaFiscalEmailSsw[] = [];
  for (const item of itens) {
    const grupos = item.match(/\d+/g);
    if (!grupos || grupos.length === 0) continue;
    let serie: string | null = null;
    let numeroRaw: string;
    if (grupos.length >= 2) {
      serie = grupos[0]!;
      numeroRaw = grupos[grupos.length - 1]!;
    } else {
      numeroRaw = grupos[0]!;
    }
    const numero = normalizeNfEmail(numeroRaw);
    if (!numero) continue;
    notas.push({ raw: item, serie, numero });
  }
  return notas;
}

/**
 * Extrai código + descrição da "Nova Situação". Dois formatos vistos:
 *   - direto:        "49 TRATATIVA DE RELACIONAMENTO ..."  (e-mail real 2026-06-17)
 *   - com prefixo:   "000 000032482 - 06 EXTRAVIO ..."     (sequência interna SSW)
 * Consome o prefixo sequencial "<nnn> <nnnnn> - " opcionalmente e pega o código.
 */
function parseNovaSituacao(valor: string | null): OcorrenciaEmailSsw | null {
  if (!valor) return null;
  const v = valor.trim();
  const m = v.match(/^\s*(?:\d+\s+\d+\s*-\s*)?(\d{1,3})\b\s*(.*)$/s);
  if (m) {
    const codigo = Number(m[1]);
    return {
      codigo: Number.isFinite(codigo) ? codigo : null,
      descricao: (m[2] ?? "").trim(),
    };
  }
  return { codigo: null, descricao: v };
}

/**
 * Parseia o corpo (HTML ou texto) de um e-mail de rastreamento do SSW.
 * Não valida remetente — quem chama deve usar `ehRemetenteSsw` no header From.
 */
export function parseEmailSswRastreamento(corpo: string): EmailSswParsed {
  const texto = htmlToText(corpo ?? "");
  return {
    remetente: valorDoRotulo(texto, ["Remetente"]),
    destinatario: valorDoRotulo(texto, ["Destinat[áa]rio"]),
    unidade: valorDoRotulo(texto, ["Unidade"]),
    dataHora: valorDoRotulo(texto, ["Data e Hora"]),
    notas: parseNotasFiscais(valorDoRotulo(texto, ["Notas? Fisca(?:l|is)"])),
    ocorrencia: parseNovaSituacao(valorDoRotulo(texto, ["Nova Situa[çc][ãa]o", "Situa[çc][ãa]o"])),
  };
}
