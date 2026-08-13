// =============================================================================
// instrucao-ssw-wurth.ts — comprime a Obs da intranet Würth no que a OPERAÇÃO
// precisa, dentro dos 70 chars do campo `f6` do SSW.
//
// PROBLEMA (Caio 2026-08-13, print do SSW na NF 669899): a instrução chegava
// cortada — `REENTREGA AUTORIZADA PELO CLIENTE VIA INTRANET WURTH - BOA TARDE! SEGU`.
// O prefixo boilerplate tinha 55 chars → sobravam 15 pro que importa. Regressão
// da MESMA classe do bug da NF 59299 (Caio 2026-06-24, descricao-ssw.ts): texto
// útil TEM que vir antes da boilerplate pra sobreviver ao corte de 70 do `f6` —
// a coluna "Instrução/Complemento" que a Operação lê. O que passa de 70 vai pro
// `observ`, que a Operação NÃO lê (ver texto-ssw-56.ts).
//
// DUAS DECISÕES (Caio 2026-08-13):
//  1. "Reentrega autorizada" é ÓBVIO — a linha do SSW já diz `21 - REENTREGA`.
//     Nada de boilerplate: os 70 chars são só pro conteúdo acionável.
//  2. Sem LLM. Determinístico como o texto-ssw-56 ("barato, testável, sem
//     custo") — e sem risco de inventar telefone/endereço que vai pro SSW.
//
// O que o motorista precisa, em ordem de prioridade: ONDE (ponto de referência),
// QUEM chamar (telefone/contato), QUANDO (janela de horário). Saudação, cortesia
// e o verbo "reentregar" são ruído — a oc já é a reentrega.
//
// Saída em CAIXA ALTA SEM ACENTO de propósito: a coluna do SSW é caixa alta e
// isso elimina qualquer risco de latin-1 no submit (ver ssw-internal-client).
// =============================================================================

/** Tamanho do campo f6 (Informações complementares) que a Operação LÊ. */
export const SSW_INSTRUCAO_MAXLEN = 70;

/**
 * Ruído de FRASE (saudação, cortesia, meta-frase, verbo redundante da própria
 * oc). Removido ANTES da extração — senão a frase "SEGUE O PONTO DE REFERENCIA
 * COMO SOLICITADO!" engana o extrator, que ancora no rótulo e leva a cortesia
 * junto ("REF COMO SOLICITADO! ..." — pego pelo teste com dado real).
 */
const RUIDO_FRASE: RegExp[] = [
  /\bSEGUE\s+O?\s*PONTO\s+D?E?\s*REFERENCIA\s+COMO\s+SOLICITADO\b[!.,]*/g,
  /\bCOMO\s+SOLICITADO\b[!.,]*/g,
  /\bCONFORME\s+SOLICITADO\b/g,
  /\bBO[AM]\s+(TARDE|DIA|NOITE)\b[!.,]*/g,
  /\bPOR\s+GENTILEZA\b/g,
  /\bGENTILEZA\b/g,
  /\bPOR\s+FAVOR\b/g,
  /\bOBRIGAD[OA]\b[!.,]*/g,
  /\bSOLICITA\s+NOVA\s+REENTREGA\b/g,
  /\bREENTREGAR\s+(A\s+)?MERCADORIA\b/g,
  /\bREAPRESENTAR\b/g,
  /\bREENTREGAR\b/g,
  /\bVENDEDOR\b/g,
];

/** Ruído de RÓTULO — removido DEPOIS da extração (é âncora pro extrator). */
const RUIDO_ROTULO: RegExp[] = [
  /\bPESSOA\s+A\s+SER\s+CONTATADA(\s+NA\s+EMPRESA)?\b/g,
  /\bTELEFONE\s+(FIXO\s+)?(PARA\s+)?CONTATO\b/g,
  /\bHORARIO\s+DE\s+RECEBIMENTO\b/g,
  /\bPONTO\s+D?E?\s*REFERENCIA\b/g,
  /\bATT\.?\b/g,
  /\bN[º°]\b/g,
];

/** Abreviações que preservam o sentido e economizam o orçamento de 70. */
const ABREV: Array<[RegExp, string]> = [
  [/\bHORARIO\s+COMERCIAL\b/g, "HOR COML"],
  [/\bMETROS\b/g, "M"],
  [/\bSENTIDO\b/g, "SENT"],
  [/\bA\s+FRENTE\b/g, "ADIANTE"],
  [/\bDO\s+LADO\s+D[AO]\b/g, "LADO"],
  [/\bAO\s+LADO\s+D[AO]\b/g, "LADO"],
  [/\bAO\s+LADO\b/g, "LADO"],
  [/\bCIDADE\s+DE\b/g, ""],
  [/\bPROXIMO\s+A[OO]?\b/g, "PROX"],
  [/\bEM\s+FRENTE\s+A[OO]?\b/g, "FRENTE"],
];

const RE_TEL = /\(?\d{2}\)?\s?\d{4,5}[-\s]?\d{4}/;
const RE_REF = /PONTO\s+D?E?\s*REFERENCIA\s*:?\s*(.+?)(?:\.(?:\s|$)|$)/;
const RE_CONTATO = /CONTATADA(?:\s+NA\s+EMPRESA)?\s*:?\s*([A-Z][A-Z ]{1,24}?)(?=\s+(?:N[º°]|TELEFONE|\d)|[.,:]|$)/;
const RE_ASSINATURA = /(?:[-.]|\bATT\.?\b)\s*([A-Z]{3,}(?:\s+[A-Z]{3,})?)\s*$/;

/** Caixa alta, sem acento, espaços colapsados (base pra regex e pra saída). */
export function normalizarObs(t: string | null | undefined): string {
  return (t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove só o ruído de FRASE, preservando os rótulos que ancoram a extração. */
function removerFrases(t: string): string {
  let s = t;
  for (const re of RUIDO_FRASE) s = s.replace(re, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Tira rótulos, abrevia e limpa pontuação órfã (usado no texto já extraído). */
function limparRuido(t: string): string {
  let s = t;
  for (const re of RUIDO_FRASE) s = s.replace(re, " ");
  for (const re of RUIDO_ROTULO) s = s.replace(re, " ");
  for (const [re, sub] of ABREV) s = s.replace(re, sub);
  return s
    .replace(/^\s*(NA|NO|EM|DE|DA|DO|AO|A|O)\s+/i, "")
    .replace(/\s*[:;,]\s*/g, " ")
    .replace(/\s*-\s*/g, " ")
    .replace(/\s*\.\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Passe agressivo pra referência que não cabe: tira conectivos que não mudam o
 * significado de um ponto de referência ("DO LADO DA PADARIA" → "LADO PADARIA").
 * Só é aplicado quando o segmento estourou — texto curto fica intacto.
 */
function compactarMais(t: string): string {
  return t
    .replace(/\b(DA|DE|DO|DAS|DOS|AO|AOS|AS|OS|E|A|O)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Corta sem quebrar palavra no meio (só cai no corte seco se a 1ª palavra estourar). */
function cortarNaPalavra(t: string, limite: number): string {
  if (t.length <= limite) return t;
  const corte = t.slice(0, limite);
  const i = corte.lastIndexOf(" ");
  return (i > limite * 0.5 ? corte.slice(0, i) : corte).trim();
}

/** Janela de horário: "HOR COML", com a ressalva do almoço quando houver. */
function janelaHorario(t: string): string | null {
  const partes: string[] = [];
  if (/\bHOR COML\b|\bCOMERCIAL\b/.test(t)) partes.push("HOR COML");
  if (/\bNAO\s+FECHA\s+(P|PARA)\s*ALMOCO\b/.test(t)) partes.push("(ALMOCO OK)");
  else if (/\b(EXCETO|EVITAR|FORA\s+DO|SEM)\s+(HORARIO\s+DE\s+)?ALMOCO\b/.test(t)) partes.push("S/ ALMOCO");
  return partes.length > 0 ? partes.join(" ") : null;
}

/**
 * Comprime a Obs da intranet no texto que vai pro SSW (≤ `limite`).
 *
 * Prioridade: REF (onde) → TEL (quem chamar) → HOR (quando) → contato/assinatura.
 * Nunca inventa: só remove, abrevia e reordena o que veio na Obs.
 * Sem nada estruturado reconhecível, devolve a Obs limpa cortada na palavra.
 */
export function comprimirInstrucaoWurth(
  obsRaw: string | null | undefined,
  limite: number = SSW_INSTRUCAO_MAXLEN,
): string {
  const bruto = normalizarObs(obsRaw);
  if (!bruto) return "";

  // Cortesia sai ANTES da extração; os rótulos ficam (são as âncoras).
  const obs = removerFrases(bruto);
  const limpo = limparRuido(bruto);
  // `truncavel`: pode entrar cortado se não couber inteiro. Referência cortada
  // ainda guia o motorista; telefone/horário pela metade desinforma — esses são
  // tudo-ou-nada. (Bug pego com dado real: a referência longa era DESCARTADA e
  // sobrava só a assinatura no SSW — pior resultado possível.)
  const segmentos: Array<{ texto: string; truncavel: boolean }> = [];

  const mRef = RE_REF.exec(obs);
  if (mRef?.[1]) {
    let ref = limparRuido(mRef[1]);
    if (ref && `REF ${ref}`.length > limite) ref = compactarMais(ref);
    if (ref) segmentos.push({ texto: `REF ${ref}`, truncavel: true });
  }

  const mTel = RE_TEL.exec(obs);
  if (mTel?.[0]) {
    segmentos.push({ texto: `TEL ${mTel[0].replace(/\s+/g, " ").trim()}`, truncavel: false });
  }

  const hor = janelaHorario(limpo);
  if (hor) segmentos.push({ texto: hor, truncavel: false });

  const mCont = RE_CONTATO.exec(obs);
  const mAss = RE_ASSINATURA.exec(obs);
  const pessoa = (mCont?.[1] ?? mAss?.[1] ?? "").trim();
  if (pessoa) segmentos.push({ texto: mCont ? `FALAR C/ ${pessoa}` : pessoa, truncavel: false });

  // Nada estruturado: devolve a Obs limpa (já sem saudação/verbo redundante).
  if (segmentos.length === 0) return cortarNaPalavra(limpo, limite);

  // Monta por prioridade enquanto couber. O que não cabe é pulado — salvo o
  // truncável, que entra cortado na palavra se ainda houver espaço útil.
  const MIN_UTIL = 20;
  let out = "";
  for (const { texto, truncavel } of segmentos) {
    const sep = out ? " | " : "";
    if ((out + sep + texto).length <= limite) {
      out += sep + texto;
      continue;
    }
    if (truncavel) {
      const espaco = limite - out.length - sep.length;
      if (espaco >= MIN_UTIL) out += sep + cortarNaPalavra(texto, espaco);
      break; // orçamento estourou: o resto não entra
    }
  }
  if (!out) out = cortarNaPalavra(segmentos[0]!.texto, limite);
  return out.slice(0, limite);
}
