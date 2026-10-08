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
  if (s.acao === "aguardar") return "aguardar";
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

// ---------------------------------------------------------------------------
// Certeza em palavras (a tela do operador não mostra porcentagem nem nome de regra).
//  - alta: 85% ou mais · média: 65% a 84% · baixa: abaixo de 65%.
//  - regra fixa da Sal (sem confiança) conta como alta: é decisão da casa.
// FIRME = regra da Sal com certeza alta → pronta para 1 clique (ou "aguardar").
// DÚVIDA = o resto → o agente analisa ou pergunta ao operador.
// ---------------------------------------------------------------------------
export type NivelCerteza = "alta" | "media" | "baixa";

export const LIMIAR_CERTEZA_ALTA = 85;
export const LIMIAR_CERTEZA_MEDIA = 65;

export function nivelCerteza(s: OpSugestao | null | undefined): NivelCerteza | null {
  if (!s || !acaoDaSugestao(s)) return null;
  const { pct } = lerConfianca(s);
  if (pct == null) return fonteDaSugestao(s) === "regra_fixa" ? "alta" : "media";
  if (pct >= LIMIAR_CERTEZA_ALTA) return "alta";
  if (pct >= LIMIAR_CERTEZA_MEDIA) return "media";
  return "baixa";
}

export const ROTULO_CERTEZA: Record<NivelCerteza, string> = {
  alta: "certeza alta",
  media: "certeza média",
  baixa: "certeza baixa",
};

/** Firme: regra da Sal (fixa ou aprendida) com certeza alta. */
export function sugestaoFirme(s: OpSugestao | null | undefined): boolean {
  if (!s || !acaoDaSugestao(s)) return false;
  return fonteDaSugestao(s) !== "agente_ia" && nivelCerteza(s) === "alta";
}

/**
 * De onde veio e quão segura é, em palavras:
 *  - aprendida: "certeza alta · aprendida com o histórico da Sal"
 *  - agente:    "analisada pelo agente · certeza média — <justificativa>"
 *  - fixa:      "regra fixa da Sal"
 */
export function textoFonte(s: OpSugestao | null | undefined): string | null {
  if (!s) return null;
  const fonte = fonteDaSugestao(s);
  const nivel = nivelCerteza(s);
  if (fonte === "agente_ia") {
    const base = nivel ? `analisada pelo agente · ${ROTULO_CERTEZA[nivel]}` : "analisada pelo agente";
    const just = (s.justificativa ?? "").trim();
    return just ? `${base} — ${just}` : base;
  }
  if (fonte === "regra_aprendida") {
    return nivel ? `${ROTULO_CERTEZA[nivel]} · aprendida com o histórico da Sal` : "aprendida com o histórico da Sal";
  }
  return "regra fixa da Sal";
}

/** Compat com a tela anterior: o pedaço de certeza, sem a fonte fixa. */
export function textoConfianca(s: OpSugestao | null | undefined): string | null {
  if (!s || fonteDaSugestao(s) === "regra_fixa") return null;
  return textoFonte(s);
}

/** "Sugestão: oc 36 — certeza alta · aprendida com o histórico da Sal" */
export function rotuloSugestao(s: OpSugestao): string {
  if (acaoDaSugestao(s) === "aguardar") return textoAguardar(s);
  const alvo = acaoDaSugestao(s) === "encaminhar_relacionamento" ? "encaminhar ao Relacionamento" : `oc ${s.codigo}`;
  const fonte = textoFonte(s);
  return fonte ? `Sugestão: ${alvo} — ${fonte}` : `Sugestão: ${alvo}`;
}

const milhar = (n: number) => n.toLocaleString("pt-BR");

/** Texto em caixa alta do histórico → frase normal ("SEGUE SOZINHA" → "Segue sozinha"). */
export function frase(t: string): string {
  const limpo = t.trim().replace(/\s+/g, " ");
  if (!limpo) return limpo;
  const maiusculas = limpo.replace(/[^A-Za-zÀ-ÿ]/g, "");
  const caixaAlta = maiusculas.length > 3 && maiusculas === maiusculas.toUpperCase();
  const base = caixaAlta ? limpo.toLowerCase() : limpo;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * O "por quê" para o operador: nunca o nome técnico da regra. "histórico: 82 casos com a
 * oc 41 (67%)" → "A Sal já viu 82 casos parecidos (mesma ocorrência 41)".
 */
export function porQueSugestao(s: OpSugestao | null | undefined): string | null {
  if (!s) return null;
  if (fonteDaSugestao(s) === "agente_ia") {
    const j = (s.justificativa ?? "").trim();
    return j ? frase(j) : "O agente comparou com notas parecidas.";
  }
  const m = (s.motivo ?? "").trim();
  const hist = /hist[oó]rico:\s*([\d.]+)\s*casos com a oc\s*(\d+)/i.exec(m);
  if (hist) {
    const n = Number(hist[1]!.replace(/\./g, ""));
    return `A Sal já viu ${milhar(n)} ${n === 1 ? "caso parecido" : "casos parecidos"} com a ocorrência ${hist[2]}.`;
  }
  const { n } = lerConfianca(s);
  if (n != null) return `A Sal já viu ${milhar(n)} ${n === 1 ? "caso parecido" : "casos parecidos"}.`;
  if (m && !/[=:_]/.test(m)) return frase(m);
  return fonteDaSugestao(s) === "regra_fixa" ? "Regra combinada com a Sal." : null;
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

/** "aguardar" (mig 439): nada a fazer agora; sem código, nunca lançável, sem botão. */
export function sugereAguardar(s: OpSugestao | null | undefined): boolean {
  return acaoDaSugestao(s) === "aguardar";
}

const FUSO = "America/Sao_Paulo";
const diaNoFuso = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: FUSO });

/**
 * "Aguardar: comprovante segue no malote · reavaliar em 14:30" (texto = o motivo). Quando o
 * reavaliar cai em outro dia: "· reavaliar em 09/10 14:30". Sem o instante, "· reavaliar em 24 h".
 */
export function textoAguardar(s: OpSugestao, agora: Date = new Date()): string {
  const bruto = (s.texto ?? s.motivo ?? "").trim().replace(/^aguardar\s*[:\-–]\s*/i, "");
  const motivo = bruto
    ? frase(bruto)
        .replace(/^./, (c) => c.toLowerCase())
        .replace(/\bvem (\d{1,2}) (.+)$/i, (_m, oc: string, desc: string) => `vem a ocorrência ${Number(oc)} (${desc})`)
    : "nada a fazer agora";
  let quando: string | null = null;
  const t = s.reavaliar_em ? Date.parse(s.reavaliar_em) : NaN;
  if (Number.isFinite(t)) {
    const d = new Date(t);
    const hora = d.toLocaleTimeString("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" });
    quando =
      diaNoFuso(d) === diaNoFuso(agora)
        ? hora
        : `${d.toLocaleDateString("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit" })} ${hora}`;
  } else if (typeof s.reavaliar_em_horas === "number" && s.reavaliar_em_horas > 0) {
    quando = `${s.reavaliar_em_horas} h`;
  }
  return quando ? `Aguardar: ${motivo} · reavaliar em ${quando}` : `Aguardar: ${motivo}`;
}
