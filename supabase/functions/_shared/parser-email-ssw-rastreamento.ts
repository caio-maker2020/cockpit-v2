// =============================================================================
// parser-email-ssw-rastreamento.ts
//
// Parser do e-mail automático de "Rastreamento de Cargas" que o SSW dispara
// (remetente sswemail@ssw.inf.br) ao cliente NO MOMENTO em que uma ocorrência
// é lançada — antes de a NF vencer prazo e aparecer no Bastão.
//
// Caio 2026-06-16: usado pelo ramo de criação antecipada de card no
// gmail-poll-inbox. Função PURA (testável com Bun) — só extrai campos do corpo
// em texto puro (gmail-reader.extrairTexto já remove HTML).
//
// Formato âncora (e-mail real ASTRAZENECA, 2026-06-16):
//   Remetente:      ASTRAZENECA DO BRASIL LTDA
//   Destinatário:   ANTONIO ERNESTO BARBIERI
//   Notas Fiscais:  2 279985, 2 279986
//   Unidade:        VIANA / ES
//   Data e Hora:    16/06/26 16:10:49
//   Nova Situação:  000 000032482 - 06 EXTRAVIO DE MERCADORIA
//                   EXTRAVIO NA TRANSFERENCIA (SSWMOBILE)
//
// Sobre "Notas Fiscais: 2 279985": o "2" é a SÉRIE e "279985" o NÚMERO da NF
// (um espaço só — não é separador de milhar, que teria dois grupos). O número
// é o que casa com cards.nf e com a busca interna do SSW (sempre sem série,
// sem zeros à esquerda). Guardamos `raw` p/ auditoria/ajuste.
// =============================================================================

export const REMETENTE_SSW = "sswemail@ssw.inf.br";

export interface NotaFiscalEmailSsw {
  raw: string; // token original, ex "2 279985"
  serie: string | null; // "2" quando há prefixo de série
  numero: string; // normalizado (sem série, sem zeros à esquerda), ex "279985"
}

export interface OcorrenciaEmailSsw {
  codigo: number | null; // ex 6
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

/** Pega o valor de um rótulo "Label:" até o fim da linha. */
function valorDoRotulo(texto: string, rotulos: string[]): string | null {
  for (const rotulo of rotulos) {
    // rótulo seguido de ':' e o valor até quebra de linha
    const re = new RegExp(`${rotulo}\\s*:\\s*([^\\r\\n]+)`, "i");
    const m = texto.match(re);
    if (m && m[1]) {
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
    // captura grupos de dígitos: 1 grupo = número; 2 grupos = série + número
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

/** "000 000032482 - 06 EXTRAVIO DE MERCADORIA" → {codigo:6, descricao:"EXTRAVIO DE MERCADORIA"} */
function parseNovaSituacao(valor: string | null): OcorrenciaEmailSsw | null {
  if (!valor) return null;
  // Após o " - " vem "<codigo> <descricao>". O bloco antes do hífen é a
  // sequência interna do SSW (ignorada).
  const aposHifen = valor.includes(" - ") ? valor.split(" - ").slice(1).join(" - ") : valor;
  const m = aposHifen.trim().match(/^(\d{1,3})\b\s*(.*)$/);
  if (m) {
    const codigo = Number(m[1]);
    return {
      codigo: Number.isFinite(codigo) ? codigo : null,
      descricao: (m[2] ?? "").trim(),
    };
  }
  return { codigo: null, descricao: aposHifen.trim() };
}

/**
 * Parseia o corpo (texto puro) de um e-mail de rastreamento do SSW.
 * Não valida remetente — quem chama deve usar `ehRemetenteSsw` no header From.
 */
export function parseEmailSswRastreamento(corpo: string): EmailSswParsed {
  const texto = corpo ?? "";
  return {
    remetente: valorDoRotulo(texto, ["Remetente"]),
    destinatario: valorDoRotulo(texto, ["Destinat[áa]rio"]),
    unidade: valorDoRotulo(texto, ["Unidade"]),
    dataHora: valorDoRotulo(texto, ["Data e Hora", "Data\\/Hora"]),
    notas: parseNotasFiscais(valorDoRotulo(texto, ["Notas Fiscais", "Nota Fiscal"])),
    ocorrencia: parseNovaSituacao(valorDoRotulo(texto, ["Nova Situa[çc][ãa]o", "Situa[çc][ãa]o"])),
  };
}
