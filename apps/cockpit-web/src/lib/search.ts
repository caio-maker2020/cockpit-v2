/**
 * Sanitiza o termo do campo de busca para uso seguro em `.or(...ilike...)`
 * do PostgREST.
 *
 * Por que existe: o PostgREST usa VÍRGULA para separar filtros e PARÊNTESES
 * para agrupar dentro do `.or()`. Se o texto do operador tiver esses chars
 * (ex: "DROGARIA ARAUJO S/A", "FULANO (MG)", "ABC, LTDA"), a expressão é
 * corrompida — a query volta 400 ou vazia, parecendo que "não há cards".
 * Num sistema onde card sumir é o pior bug, uma busca que engole resultado
 * é inaceitável.
 *
 * O que remove: `%` (curinga do ILIKE), vírgula, parênteses e barra invertida.
 * Tradeoff aceito: uma busca com vírgula perde a vírgula (vira 2 palavras),
 * o que degrada levemente o match — mas nunca corrompe a query nem esconde
 * resultado por erro.
 */
export function sanitizeSearch(raw: string): string {
  return raw.trim().replace(/[%,()\\]/g, " ").replace(/\s{2,}/g, " ").trim();
}
