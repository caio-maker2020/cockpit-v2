// =============================================================================
// Leitura tolerante da sugestão (ADR 0041 D6 + regras geradas do histórico real).
// A sugestão NUNCA lança sozinha: aceitar abre a prévia e pede o clique.
// =============================================================================
import type { OpSugestao } from "./tipos";

export interface ConfiancaSugestao {
  /** 0–100, inteiro. null quando a regra não informou. */
  pct: number | null;
  /** "a Sal fez isso em N de M casos parecidos" */
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

/** "82% (a Sal fez isso em 41 de 50 casos parecidos)" — ou o pedaço que houver. */
export function textoConfianca(s: OpSugestao | null | undefined): string | null {
  const c = lerConfianca(s);
  const casos =
    c.n != null && c.m != null
      ? `a Sal fez isso em ${c.n} de ${c.m} casos parecidos`
      : c.n != null
        ? `a Sal fez isso em ${c.n} casos parecidos`
        : null;
  if (c.pct != null) return casos ? `${c.pct}% (${casos})` : `${c.pct}%`;
  return casos;
}

/** "Sugestão: 36 — 82% (a Sal fez isso em 41 de 50 casos parecidos)" */
export function rotuloSugestao(s: OpSugestao): string {
  const conf = textoConfianca(s);
  return conf ? `Sugestão: ${s.codigo} — ${conf}` : `Sugestão: ${s.codigo}`;
}

/**
 * A sugestão vira botão? `lancavel: false` explícito manda (o materializador já
 * conferiu a lista). Sem o campo, decide pela lista de códigos liberados, se conhecida.
 */
export function sugestaoLancavel(s: OpSugestao | null | undefined, codigosLiberados: ReadonlySet<number> | null): boolean {
  if (!s || typeof s.codigo !== "number") return false;
  if (s.lancavel === false) return false;
  if (codigosLiberados) return codigosLiberados.has(s.codigo);
  return s.lancavel === true;
}
