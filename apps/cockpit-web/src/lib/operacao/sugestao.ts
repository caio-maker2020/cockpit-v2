// =============================================================================
// Leitura tolerante da sugestão: contrato v2 do ADR 0041 (D10/D11), o formato
// antigo (regra pura) e o do fixture ({confianca, casos:{n,m}}).
// A sugestão NUNCA age sozinha: lançar abre a prévia do lançamento; encaminhar
// abre a prévia do encaminhamento (texto exato da 49). Cada ação, seu botão.
// =============================================================================
import type { AcaoSugestao, FonteSugestao, OpSugestao } from "./tipos";

export interface ConfiancaSugestao {
  /** 0–100, inteiro. null quando não informado. */
  pct: number | null;
  /** casos parecidos em que a Sal fez isso (N) e o total (M), quando houver. */
  n: number | null;
  m: number | null;
}

export function lerConfianca(s: OpSugestao | null | undefined): ConfiancaSugestao {
  if (!s) return { pct: null, n: null, m: null };
  let pct: number | null = null;
  if (typeof s.confianca === "number" && Number.isFinite(s.confianca)) {
    pct = Math.round(s.confianca <= 1 ? s.confianca * 100 : s.confianca);
    pct = Math.max(0, Math.min(100, pct));
  }
  let n: number | null = null;
  let m: number | null = null;
  if (typeof s.casos === "number") {
    n = s.casos;
    m = typeof s.casos_total === "number" ? s.casos_total : null;
  } else if (s.casos && typeof s.casos === "object") {
    n = typeof s.casos.n === "number" ? s.casos.n : null;
    m = typeof s.casos.m === "number" ? s.casos.m : null;
  }
  if (pct == null && n != null && m != null && m > 0) pct = Math.round((n / m) * 100);
  return { pct, n, m };
}

/** Ausente = lançar ocorrência (formato antigo). */
export function acaoDaSugestao(s: OpSugestao | null | undefined): AcaoSugestao | null {
  if (!s) return null;
  if (s.acao === "encaminhar_relacionamento") return "encaminhar_relacionamento";
  return typeof s.codigo === "number" ? "lancar_ocorrencia" : null;
}

/** v2 diz a fonte; sem ela, infere: base_regra "agente_ia" → agente; com histórico → aprendida; senão fixa. */
export function fonteDaSugestao(s: OpSugestao): FonteSugestao {
  if (s.fonte === "regra_fixa" || s.fonte === "regra_aprendida" || s.fonte === "agente_ia") return s.fonte;
  if (s.base_regra === "agente_ia" || s.regra_id === "agente_ia" || !!s.modelo) return "agente_ia";
  const c = lerConfianca(s);
  if (c.n != null || c.pct != null) return "regra_aprendida";
  return "regra_fixa";
}

/**
 * De onde veio e quão segura é:
 *  - aprendida: "82% (aprendida com a Sal: 41 de 50 casos parecidos)"
 *  - agente:    "agente de IA: 72% — <justificativa>"
 *  - fixa:      "regra fixa"
 */
export function textoFonte(s: OpSugestao | null | undefined): string | null {
  if (!s) return null;
  const fonte = fonteDaSugestao(s);
  const c = lerConfianca(s);
  if (fonte === "agente_ia") {
    const base = c.pct != null ? `agente de IA: ${c.pct}%` : "agente de IA";
    const just = (s.justificativa ?? "").trim();
    return just ? `${base} — ${just}` : base;
  }
  if (fonte === "regra_aprendida") {
    const casos =
      c.n != null && c.m != null
        ? `aprendida com a Sal: ${c.n} de ${c.m} casos parecidos`
        : c.n != null
          ? `aprendida com a Sal: ${c.n} casos parecidos`
          : "aprendida com a Sal";
    return c.pct != null ? `${c.pct}% (${casos})` : casos;
  }
  return "regra fixa";
}

/** Compat com a tela anterior: o pedaço de confiança, sem a fonte fixa. */
export function textoConfianca(s: OpSugestao | null | undefined): string | null {
  if (!s || fonteDaSugestao(s) === "regra_fixa") return null;
  return textoFonte(s);
}

/** "Sugestão: 36 — 82% (aprendida com a Sal: 41 de 50 casos parecidos)" ou "Sugestão: encaminhar ao Relacionamento — agente de IA: 72% — …" */
export function rotuloSugestao(s: OpSugestao): string {
  const alvo = acaoDaSugestao(s) === "encaminhar_relacionamento" ? "encaminhar ao Relacionamento" : String(s.codigo);
  const fonte = textoFonte(s);
  return fonte ? `Sugestão: ${alvo} — ${fonte}` : `Sugestão: ${alvo}`;
}

/**
 * A sugestão de LANÇAR vira botão? Só com código liberado. `lancavel: false` explícito
 * manda; sem o campo, decide pela lista de códigos, se conhecida. Encaminhar nunca é "lançável".
 */
export function sugestaoLancavel(
  s: OpSugestao | null | undefined,
  codigosLiberados: ReadonlySet<number> | null,
  /** oc atual do item: sugerir a própria oc não faz nada (o contrato proíbe; o servidor recusa com ja_e_a_ultima_oc). */
  ocAtual?: number | null,
): boolean {
  if (acaoDaSugestao(s) !== "lancar_ocorrencia") return false;
  if (ocAtual != null && s!.codigo === ocAtual) return false;
  if (s!.lancavel === false) return false;
  if (codigosLiberados) return codigosLiberados.has(s!.codigo as number);
  return s!.lancavel === true;
}

export function sugereEncaminhar(s: OpSugestao | null | undefined): boolean {
  return acaoDaSugestao(s) === "encaminhar_relacionamento";
}

/** Por que a sugestão de lançar não vira botão (null = vira). */
export function motivoSugestaoSoRegistro(
  s: OpSugestao | null | undefined,
  codigosLiberados: ReadonlySet<number> | null,
  ocAtual?: number | null,
): string | null {
  if (acaoDaSugestao(s) !== "lancar_ocorrencia") return null;
  if (sugestaoLancavel(s, codigosLiberados, ocAtual)) return null;
  if (ocAtual != null && s!.codigo === ocAtual) return "Só registro: o código sugerido já é a oc atual.";
  return "Só registro: código ainda não liberado.";
}
