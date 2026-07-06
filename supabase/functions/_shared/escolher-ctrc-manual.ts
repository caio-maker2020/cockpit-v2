// =============================================================================
// escolher-ctrc-manual.ts
//
// Seleção de CTRC para a feature "Criar Card" MANUAL (Caio 2026-06-26).
//
// Diferente do `escolherCtrc` de criar-card-via-ssw.ts (que esconde REVERSA /
// complementar e SEMPRE devolve o NORMAL): aqui o operador PODE querer o card
// do CTRC de DEVOLUÇÃO. Regra do Caio:
//
//   "caso tenha 2 CTRC da mesma NF com o pagador, NÃO finalizados e NÃO
//    complementar, pergunte se ele quer o CTRC de devolução ou o normal."
//
// Esta é uma função PURA e total (sem SSW, sem DB) — o flag `finalizado` é
// calculado pelo caller (precisa ler a última oc de cada CTRC no SSW, que é IO).
// Guard de não-regressão: escolher-ctrc-manual.test.ts.
//
// REGRA DE OURO preservada: nunca chutar CTRC. Qualquer forma não-resolúvel
// (≥2 NORMAIS, ≥2 reversas, tipo desconhecido) cai em "ambiguo" → o caller NÃO
// cria card e devolve erro claro pro operador escolher/conferir manualmente.
// =============================================================================

export interface CtrcCandidatoManual {
  /** CTRC normalizado, ex: "AMB368633-7". */
  ctrc: string;
  /**
   * Tipo Colet (f2 do XML): "NORMAL" (original), "REVERSA" (devolução),
   * "" (vazio). ATENÇÃO: "" tem 2 significados —
   *   - na LISTA (≥2 CTRCs, XML): "" = COMPLEMENTAR/REENTREGA (filtrado da escolha);
   *   - no DETALHE-ÚNICO (1 CTRC só): "" = DESCONHECIDO (o SSW não trouxe XML).
   * Por isso o caminho `ativos.length === 1` trata "" como o próprio CTRC.
   */
  tipo: string;
  /** Nome do pagador como aparece no SSW (pode vir vazio no detalhe-único). */
  pagador: string | null;
  /** true se o CTRC está cancelado (coluna "Ca" / f12). */
  cancelado: boolean;
  /** true se a última oc do CTRC ∈ OCS_FINALIZADORAS {1,30,32} (calculado pelo caller). */
  finalizado: boolean;
}

export type EscolhaCtrcManual =
  | { tipo: "unico"; ctrc: CtrcCandidatoManual }
  | { tipo: "escolher"; opcoes: CtrcCandidatoManual[] } // NORMAL + REVERSA(s), todos elegíveis
  | { tipo: "sem_ctrc_ativo" }
  | { tipo: "ambiguo"; motivo: string; candidatos: CtrcCandidatoManual[] };

/**
 * Decide qual CTRC usar pro card manual a partir dos candidatos já lidos do SSW.
 *
 * @param candidatos lista bruta de CTRCs da NF (com `cancelado` e `finalizado`
 *                   preenchidos pelo caller). NÃO precisa estar pré-filtrada.
 */
export function escolherCtrcManual(
  candidatos: CtrcCandidatoManual[],
): EscolhaCtrcManual {
  const ativos = candidatos.filter((c) => !c.cancelado);
  if (ativos.length === 0) return { tipo: "sem_ctrc_ativo" };

  // 1 CTRC só (inclui o caminho de detalhe-único do SSW, onde tipo vem "" =
  // DESCONHECIDO, não "complementar"): é ele. Não há escolha a oferecer.
  if (ativos.length === 1) {
    const c = ativos[0]!;
    return c.finalizado ? { tipo: "sem_ctrc_ativo" } : { tipo: "unico", ctrc: c };
  }

  // ≥2 CTRCs → veio da LISTA (XML), tipo é confiável. Elegíveis = não-finalizados
  // E não-complementares (tipo===""). A escolha é só entre NORMAL e REVERSA.
  const elegiveis = ativos.filter((c) => !c.finalizado && c.tipo.trim() !== "");
  if (elegiveis.length === 0) return { tipo: "sem_ctrc_ativo" };
  if (elegiveis.length === 1) return { tipo: "unico", ctrc: elegiveis[0]! };

  const normais = elegiveis.filter((c) => c.tipo.toUpperCase() === "NORMAL");
  const reversas = elegiveis.filter((c) => c.tipo.toUpperCase() === "REVERSA");
  const outros = elegiveis.length - normais.length - reversas.length;

  // ÚNICO caso resolúvel pra "escolher": exatamente 1 NORMAL + ≥1 REVERSA, todos
  // elegíveis. Operador decide devolução vs normal.
  if (outros === 0 && normais.length === 1 && reversas.length >= 1) {
    return { tipo: "escolher", opcoes: [normais[0]!, ...reversas] };
  }

  // Qualquer outra forma (≥2 NORMAIS, ≥2 reversas sem normal, tipo desconhecido)
  // → não chutar.
  return {
    tipo: "ambiguo",
    motivo: outros > 0
      ? "tipo_ctrc_desconhecido"
      : normais.length >= 2
      ? "multiplos_ctrcs_normais"
      : "multiplas_reversas",
    candidatos: elegiveis,
  };
}
