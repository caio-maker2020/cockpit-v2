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

// =============================================================================
// Rodízio justo entre caixas (Caio 2026-07-23, NF 389040 DUILIO).
//
// O sequencial-com-orçamento do PR #24 dependia da ordenação "caixa mais
// defasada primeiro" pra garantir que nenhuma caixa morresse de fome. A
// ordenação NUNCA funcionou: o embed `gmail_polling_state(last_poll_at)` do
// PostgREST volta como OBJETO (relação 1-pra-1 — a PK de gmail_polling_state
// é o próprio operador_id), mas o código lia `[0]` como se fosse array →
// undefined pra todo mundo → sem ordenação → ordem natural da tabela →
// KAROLINE+JULIA comiam os 100s de orçamento em TODA rodada e as outras 7
// caixas ficavam com ZERO leituras (43 capturas/dia do DUILIO → 1).
// Helpers puros + testes pra isso nunca regredir em silêncio (INV-043).
// =============================================================================

/** Embed do PostgREST: objeto (1-pra-1) OU array (shape antigo/defensivo). */
export type EmbedPollingState =
  | { last_poll_at?: string | null }
  | Array<{ last_poll_at?: string | null }>
  | null
  | undefined;

/** Extrai last_poll_at tolerando os DOIS formatos de embed. */
export function lastPollAtDoEmbed(embed: EmbedPollingState): string | null {
  if (!embed) return null;
  if (Array.isArray(embed)) return embed[0]?.last_poll_at ?? null;
  return embed.last_poll_at ?? null;
}

/**
 * Ordena caixas pela defasagem: nunca-lidas (null) primeiro, depois a mais
 * antiga. Timestamps ISO comparam lexicograficamente.
 */
export function ordenarPorDefasagem<T>(
  ops: T[],
  lastPollOf: (op: T) => string | null,
): T[] {
  return [...ops].sort((a, b) => {
    const aL = lastPollOf(a);
    const bL = lastPollOf(b);
    if (!aL && !bL) return 0;
    if (!aL) return -1;
    if (!bL) return 1;
    return aL.localeCompare(bL);
  });
}

// =============================================================================
// Memória de avaliação por mensagem (causa-2, Matheus 2026-07-23).
//
// Sintoma medido em produção: TODA caixa fechava a rodada com `backlog: NNN
// msgs não processadas (budget)` (sac 436, julia 427, larissa 410, auto.pecas
// 402, ferramentas 387, victor 348) e `last_success_at` travado em junho — as
// caixas não fechavam uma rodada limpa há ~1 mês. Causa: cada mensagem
// não-casada re-executava `getMensagemMetadata` (roundtrip Gmail) A CADA rodada,
// porque nada lembrava que ela já tinha sido avaliada; a janela `newer_than:30d`
// sem `is:unread` mantém tudo re-listado até envelhecer 30 dias.
//
// Fix (flag `gmail_poll_memo_avaliacao_ativo`): prefetch em lote de (a) ids já
// ingeridos em messages_inbox e (b) ids já avaliados sem match (memo). Na
// re-avaliação o poller reusa nf/domínio cacheados e re-roda só o match no banco
// (late-binding preservado) — sem fetch no Gmail e sem re-enfileirar o scan
// divergente. Estes helpers são as reduções puras dos dois prefetches.
// =============================================================================

/** Avaliação anterior de uma mensagem não-casada, reduzida do memo. */
export type MemoAvaliacao = {
  nf: string | null;
  dominio: string | null;
  scanEnfileirado: boolean;
};

/** Linha crua de `gmail_poll_msg_avaliada`. */
export type MemoAvaliacaoRow = {
  gmail_message_id?: string | null;
  nf_extraida?: string | null;
  dominio_remetente?: string | null;
  scan_divergente_enfileirado?: boolean | null;
};

/** Reduz linhas do memo em Map(gmail_message_id → avaliação). Ids nulos caem. */
export function mapaMemoAvaliacao(
  rows: MemoAvaliacaoRow[],
): Map<string, MemoAvaliacao> {
  const mapa = new Map<string, MemoAvaliacao>();
  for (const r of rows) {
    if (!r.gmail_message_id) continue;
    mapa.set(r.gmail_message_id, {
      nf: r.nf_extraida ?? null,
      dominio: r.dominio_remetente ?? null,
      scanEnfileirado: r.scan_divergente_enfileirado === true,
    });
  }
  return mapa;
}

/** Reduz linhas com `gmail_message_id` em Set. Ids nulos/vazios caem. */
export function setDeGmailMessageIds(
  rows: Array<{ gmail_message_id?: string | null }>,
): Set<string> {
  const set = new Set<string>();
  for (const r of rows) if (r.gmail_message_id) set.add(r.gmail_message_id);
  return set;
}
