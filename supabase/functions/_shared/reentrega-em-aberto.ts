// =============================================================================
// reentrega-em-aberto — parser do Duilio (playbook 02/09, p11).
//
// "Após a 21 vai constar uma instrução (SEM número de ocorrência) como
//  'CTRC OVD452891-3 EMITIDO PARA REENTREGA'. (...) a reentrega em aberto
//  seria a mensagem sem andamento, ou seja, sem nenhuma ocorrência a seguir —
//  na maioria das vezes deveria ser 14 (Entrega iniciada) ou 5 (Em
//  transferência). Ela pode vir posterior à 21 do operador OU, em clientes
//  com reentrega automática, após uma 13."
//
// Usos: R5 emenda (c) — card em 13 sem reentrega em aberto + LLM sugerindo 55
// → o certo é 21 (âncora NF 26033, ISABELY: "lançar 21 pra tentar a reentrega
// pela impossibilidade da 13"; a 55 não emite o CTRC de reentrega).
// =============================================================================

const MARCA_REENTREGA = /EMITID[OA]\s+PARA\s+REENTREGA/i;

/** Ocorrências que representam ANDAMENTO após a emissão da reentrega. */
const OCS_ANDAMENTO: ReadonlySet<number> = new Set([1, 5, 10, 11, 13, 14, 19, 35]);

/** Há reentrega EM ABERTO? (CTRC de reentrega emitido — linha sem código ou
 *  oc 21 — sem nenhuma ocorrência de andamento depois). Histórico em ordem
 *  cronológica (mesma ordem do historico_ssw do card). */
export function reentregaEmAberto(
  historico: ReadonlyArray<{ codigo: number | null; instrucao: string | null }>,
): boolean {
  let idxEmissao = -1;
  for (let i = 0; i < historico.length; i++) {
    const o = historico[i]!;
    if (o.codigo === 21 || MARCA_REENTREGA.test(o.instrucao ?? "")) idxEmissao = i;
  }
  if (idxEmissao < 0) return false;
  for (let i = idxEmissao + 1; i < historico.length; i++) {
    if (OCS_ANDAMENTO.has(historico[i]!.codigo ?? -1)) return false;
  }
  return true;
}
