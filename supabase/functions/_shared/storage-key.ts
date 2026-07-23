// =============================================================================
// storage-key — sanitização do nome de arquivo pra virar object key do
// Supabase Storage sem ser rejeitado com "Invalid key".
//
// Caio 2026-07-08 (bug Isa/Karol — NF 924, CTRC AMB336505-1): a operadora
// tentou anexar `karol.ed095818570ssw1419SEP[1]095818.pdf` na aba RESPOSTA e o
// Storage devolveu `Invalid key: <card>/<uuid>/...SEP[1]095818.pdf`. O sufixo
// `[1]` é o que o Windows/navegador coloca ao baixar arquivo cujo nome já
// existe (duplicata) — nome comum, não erro do operador.
//
// RAIZ: o sanitizador antigo era BLOCKLIST (`/[\r\n"\\/]/`), só removia 5
// caracteres e deixava passar `[ ] # % { }` etc. O Supabase Storage valida a
// key contra uma WHITELIST fechada de caracteres; colchetes não estão nela.
//
// FIX (allowlist, não blocklist): mantém só caracteres seguros e legíveis pro
// nome do arquivo — letras, dígitos, ` . _ - ( ) ` e espaço — e troca TODO o
// resto por `_`. Fecha a classe inteira de caracteres inválidos de uma vez
// (não só o colchete do caso âncora). A unicidade real do path vem do
// `card_id/uuid/` na frente; o nome é só rótulo legível.
// =============================================================================

/**
 * Caracteres permitidos no componente de nome de arquivo de uma object key.
 * Conservador de propósito: subconjunto do que o Storage aceita, sem `/`
 * (separador de path) e sem os símbolos exóticos que o Storage tolera mas que
 * não agregam nada a um nome de arquivo. Qualquer coisa fora disso vira `_`.
 */
const CHARS_PERMITIDOS_NO_NOME = /[^A-Za-z0-9._\-() ]/g;

const MAX_FILENAME_LEN = 200;

/**
 * Sanitiza `filename` pra ser seguro como componente de object key do Supabase
 * Storage. Troca todo caractere fora da allowlist por `_`, limita a 200 chars
 * e nunca retorna vazio (fallback `arquivo`).
 *
 * Idempotente: rodar 2x dá o mesmo resultado.
 */
export function sanitizarNomeArquivoParaStorageKey(filename: string): string {
  const limpo = (filename ?? "")
    .replace(CHARS_PERMITIDOS_NO_NOME, "_")
    .slice(0, MAX_FILENAME_LEN)
    .trim();
  // Nome vazio, ou reduzido a `.`/`..`/só `_`, não serve como key legível.
  if (!limpo || /^[._]+$/.test(limpo)) return "arquivo";
  return limpo;
}
