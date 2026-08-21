// =============================================================================
// paginarTudo — FIX do teto de 1000 (auditoria do Caio 21/08: "cards tratados
// travados em 1000"). O PostgREST do Supabase corta QUALQUER select em 1000
// linhas por requisição — .limit(20000) é silenciosamente ignorado. Este helper
// pagina via range() até a página vir incompleta. Guard: INV-088.
// =============================================================================

export const PAGINA_SUPABASE = 1000;

/**
 * Busca todas as linhas paginando de PAGINA_SUPABASE em PAGINA_SUPABASE.
 * `fetchPage(from, to)` deve aplicar `.range(from, to)` na query.
 * `maxPaginas` é o teto de segurança (30 páginas = 30k linhas).
 */
export async function paginarTudo<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  maxPaginas = 30,
): Promise<T[]> {
  const tudo: T[] = [];
  for (let p = 0; p < maxPaginas; p++) {
    const from = p * PAGINA_SUPABASE;
    const pagina = await fetchPage(from, from + PAGINA_SUPABASE - 1);
    tudo.push(...pagina);
    if (pagina.length < PAGINA_SUPABASE) break;
  }
  return tudo;
}
