// Helpers puros do gmail-poll-inbox pra processamento em lote.
//
// Contexto (Matheus/Larissa 2026-07-22, NF 1504049 COMERCIAL AUTOMOTIVA):
// o poller fazia 2 queries de banco + 1 fetch Gmail POR MENSAGEM não casada,
// com até 500 msgs/caixa × 8 caixas EM PARALELO a cada 5 min. Resultado:
// WORKER_RESOURCE_LIMIT (HTTP 546) em ~toda rodada — 69 mortes em 6h — e
// caixas pesadas (auto.pecas/FELIPE) nunca completavam um poll: resposta de
// cliente ficava invisível pro Cockpit. Estes helpers viabilizam o lookup em
// lote (1 query por caixa) e a partição em chunks respeitando limite de URL
// do PostgREST.

export function particionarEmChunks<T>(arr: T[], tamanho: number): T[][] {
  if (tamanho <= 0) throw new Error(`tamanho de chunk inválido: ${tamanho}`);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += tamanho) out.push(arr.slice(i, i + tamanho));
  return out;
}

/**
 * Constrói mapa chave → valor ficando com a linha MAIS RECENTE por chave.
 * Substitui o padrão "1 query com order+limit(1) por mensagem" por
 * "1 query em lote + redução em memória". Linhas com chave/valor nulos são
 * ignoradas. Timestamps ISO comparam lexicograficamente.
 */
export function mapaMaisRecentePorChave<R>(
  rows: R[],
  getChave: (r: R) => string | null | undefined,
  getValor: (r: R) => string | null | undefined,
  getTs: (r: R) => string | null | undefined,
): Map<string, string> {
  const ordenadas = [...rows].sort((a, b) =>
    (getTs(b) ?? "").localeCompare(getTs(a) ?? ""),
  );
  const mapa = new Map<string, string>();
  for (const r of ordenadas) {
    const chave = getChave(r);
    const valor = getValor(r);
    if (chave && valor && !mapa.has(chave)) mapa.set(chave, valor);
  }
  return mapa;
}
