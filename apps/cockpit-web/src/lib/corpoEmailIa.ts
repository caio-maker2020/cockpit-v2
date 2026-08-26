// =============================================================================
// corpoEmailIa — mede se a operadora ALTEROU o corpo de e-mail sugerido pela IA
// (Etapa C do plano de veto, Caio 25/08: "ALTERACAO QUE DEVE SER METRIFICADA
// E VIRAR DADO ESTRUTURADO PRO MODELO DE APRENDIZADO").
//
// Os flags viajam nos extras da aprovação (ia_corpo_sugerido_usado /
// ia_corpo_alterado) → caem no audit_log/payload do todo → a Auditoria e o
// loop de aprendizado leem de lá. NUNCA entram no texto do SSW (whitelist
// EXTRAS_PRA_DESCRICAO_SSW não os inclui — por construção).
//
// Comparação por CONTEÚDO: espaços/quebras não contam como edição (o editor
// reformata sozinho); qualquer mudança de texto real conta.
// =============================================================================

function normalizar(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export interface MedidaCorpoIa {
  /** Havia corpo sugerido pela IA neste envio. */
  usado: boolean;
  /** A operadora mudou o CONTEÚDO (não só whitespace). */
  alterado: boolean;
}

export function medirAlteracaoCorpoIa(
  corpoSugerido: string | null | undefined,
  corpoFinal: string,
): MedidaCorpoIa {
  const sugerido = (corpoSugerido ?? "").trim();
  if (!sugerido) return { usado: false, alterado: false };
  return { usado: true, alterado: normalizar(sugerido) !== normalizar(corpoFinal) };
}
