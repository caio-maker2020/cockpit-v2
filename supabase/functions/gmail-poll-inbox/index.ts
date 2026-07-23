// =============================================================================
// gmail-poll-inbox — Edge Function (Deno runtime)
//
// Caio 2026-05-06: captura respostas dos clientes a emails enviados pelo
// Cockpit (via Gmail OAuth da Larissa). Filtro por label `cockpit-tracked`
// garante zero ruído (não pega emails pessoais).
//
// Pipeline:
//   1. Pra cada operador com gmail_oauth_credentials:
//   2. Refresh access_token
//   3. Garante label cockpit-tracked existe (cacheia ID em gmail_polling_state)
//   4. Lista mensagens não lidas com query: label:cockpit-tracked is:unread newer_than:7d
//   5. Pra cada msg:
//      a. Lookup card_id em cards_emails_outbound via In-Reply-To OU thread_id
//      b. Se acha: INSERT messages_inbox com card_id já preenchido
//      c. Marca como lida (removeLabelIds=UNREAD) pra não reprocessar
//   6. Vinculador (job existente) detecta nova msg + dispara fluxo IA
//
// Roda em cron 5min (migration 061). Latência total cliente→Larissa: ~5min.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  loadOperadorGmailCreds,
  refreshGmailAccessToken,
} from "../_shared/gmail-sender.ts";
import {
  lastPollAtDoEmbed,
  mapaMaisRecentePorChave,
  mapaMemoAvaliacao,
  ordenarPorDefasagem,
  particionarEmChunks,
  setDeGmailMessageIds,
} from "../_shared/gmail-poll-batch.ts";
import type { MemoAvaliacao, MemoAvaliacaoRow } from "../_shared/gmail-poll-batch.ts";
import {
  garantirLabelCockpitTracked,
  listarMensagensNaoLidas,
  getMensagemFull,
  getMensagemMetadata,
  getThreadMin,
  marcarComoLida,
  getHeader,
  extrairTexto,
  flattenPartsDecoded,
  normalizeMessageId,
  extrairAnexos,
  selecionarAnexosParaSalvar,
  baixarAttachment,
} from "../_shared/gmail-reader.ts";
import { parseBounceNdr } from "../_shared/parse-bounce-ndr.ts";
// Caio 2026-06-16: criação antecipada de card a partir do e-mail automático do
// SSW (sswemail@ssw.inf.br). Gated por flag + operador COCKPIT + whitelist de NF.
import { tentarCriarCardViaSswEmail } from "../_shared/criar-card-via-ssw.ts";
import { surfarThreadDivergenteSeCasar } from "../_shared/scan-email-enqueue.ts";
// Caio 2026-07-21 (onboarding Karoline): encaminha cópia da resposta pra caixa
// do novo dono quando o card foi reatribuído. Blindado no call-site.
import { encaminharRespostaSeReatribuido } from "../_shared/encaminhar-email-reatribuido.ts";

interface Operador {
  id: string;
  email: string | null;
  gmail_oauth_credentials: { refresh_token?: string } | null;
}

interface PollSummary {
  operador_id: string;
  operador_email: string | null;
  msgs_listadas: number;
  msgs_vinculadas: number;
  msgs_ignoradas: number;
  cards_revertidos_por_resposta_operadora: number;
  erros: string[];
}

serve(async (req) => {
  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResp({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Admin mode: { force_thread_id: "xxx", operador_email: "larissa@..." }
  // Re-aplica label cockpit-tracked + marca thread como unread → próximo
  // polling re-captura como se fosse nova msg. Útil pra retroativo.
  let body: Record<string, unknown> = {};
  try {
    if (req.method === "POST") body = await req.json();
  } catch { /* sem body */ }

  if (body.force_thread_id && typeof body.force_thread_id === "string") {
    return await reativarThread(supabase, body.force_thread_id as string, body.operador_email as string | undefined);
  }

  // Debug: inspeciona labels das mensagens unread com label cockpit-tracked
  if (body.debug === true) {
    return await debugInspect(supabase, body.operador_email as string | undefined);
  }

  // Debug: inspeciona uma thread específica (todos os msgs com labels +
  // internalDate). Útil pra entender por que detectarRespostasOperadora
  // não disparou.
  if (body.inspect_thread && typeof body.inspect_thread === "string") {
    return await debugInspectThread(supabase, body.inspect_thread as string, body.operador_email as string | undefined);
  }

  // Lista operadores com Gmail OAuth conectado. Caio 2026-05-26 (NF 132109):
  // LEFT JOIN com gmail_polling_state ordena ASC por last_poll_at (NULLS
  // PRIMEIRO) — operador mais defasado é processado primeiro. Antes da
  // mudança, LARISSA consumia o timeout de 150s e DUILIO/DURAFA nunca rodavam.
  const { data: operadoresRaw, error: opErr } = await supabase
    .from("operadores")
    .select("id, email, gmail_oauth_credentials, gmail_polling_state(last_poll_at)")
    .not("gmail_oauth_credentials", "is", null);

  if (opErr) {
    return jsonResp({ ok: false, error: `Listar operadores: ${opErr.message}` }, 500);
  }

  // Ordena: NULL last_poll_at primeiro, depois ASC (mais antigo)
  // Caio 2026-07-23 (NF 389040 DUILIO): o sort antigo lia o embed como ARRAY
  // ([0]), mas o PostgREST devolve OBJETO na relação 1-pra-1 → undefined pra
  // todos → ordenação virava empate → KAROLINE+JULIA monopolizavam o budget e
  // 7 caixas ficavam sem NENHUMA leitura (43 capturas/dia do DUILIO → 1).
  // Fonte única testada: lastPollAtDoEmbed + ordenarPorDefasagem (INV-043).
  const operadoresOrdenados = ordenarPorDefasagem(
    ((operadoresRaw ?? []) as Array<
      Operador & { gmail_polling_state?: Parameters<typeof lastPollAtDoEmbed>[0] }
    >).filter((op) => op.gmail_oauth_credentials?.refresh_token),
    (op) => lastPollAtDoEmbed(op.gmail_polling_state),
  );

  // Matheus 2026-07-22 (NF 1504049 COMERCIAL AUTOMOTIVA): SEQUENCIAL com
  // orçamento de tempo, substituindo o Promise.allSettled de 2026-05-26.
  // O paralelo ilimitado (8 caixas × até 500 msgs × fetch de metadata por msg
  // não casada) matava o worker com WORKER_RESOURCE_LIMIT (546) em ~toda
  // rodada — 69 mortes em 6h — e caixa pesada (auto.pecas/FELIPE) NUNCA
  // completava um poll: resposta do cliente ficava invisível. A garantia que
  // o allSettled dava (um operador não bloquear os outros) agora vem do
  // orçamento: quem não coube fica pra próxima rodada, e a ordenação
  // NULLS-primeiro/mais-defasado-primeiro faz o rodízio ser justo.
  const RUN_BUDGET_MS = 100_000;
  const FATIA_POR_CAIXA_MS = 25_000;
  const deadline = startedAt + RUN_BUDGET_MS;
  const summaries: PollSummary[] = [];
  let caixasPuladasPorBudget = 0;

  for (const op of operadoresOrdenados) {
    if (Date.now() > deadline) {
      caixasPuladasPorBudget++;
      continue; // só conta — a caixa fica mais defasada e sobe na próxima rodada
    }
    const summary: PollSummary = {
      operador_id: op.id,
      operador_email: op.email,
      msgs_listadas: 0,
      msgs_vinculadas: 0,
      msgs_ignoradas: 0,
      cards_revertidos_por_resposta_operadora: 0,
      erros: [],
    };

    try {
      // Caio 2026-07-23 (NF 389040): FATIA por caixa dentro do orçamento
      // global. Sem isso, uma caixa pesada (KAROLINE re-mastiga ~300 msgs
      // não-casadas <7d TODA rodada) come os 100s sozinha e o rodízio nunca
      // chega nas demais. Com a fatia, >=4 caixas rodam por rodada e o ciclo
      // completo das 9 fecha em <=3 rodadas (15min). A caixa cortada continua
      // de onde parou (rodada parcial + checkpoint já existentes).
      const fatiaDeadline = Math.min(deadline, Date.now() + FATIA_POR_CAIXA_MS);
      await processarOperador(supabase, op, summary, fatiaDeadline);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.erros.push(`fatal: ${msg}`);
      await supabase.from("gmail_polling_state").upsert({
        operador_id: op.id,
        last_poll_at: new Date().toISOString(),
        last_error: msg,
      });
    }

    summaries.push(summary);
  }

  return jsonResp({
    ok: true,
    duration_ms: Date.now() - startedAt,
    operadores_processados: summaries.length,
    caixas_puladas_por_budget: caixasPuladasPorBudget,
    summaries,
  }, 200);
});

// =============================================================================
// Causa-2 (Matheus 2026-07-23): memória de avaliação por mensagem.
// Contexto e desenho em _shared/gmail-poll-batch.ts + ADR 0015 + migration 306.
// =============================================================================

/** Prefetch em lote passado ao processamento de cada mensagem da rodada. */
type MemoCtx = {
  /** gmail_message_ids já ingeridos em messages_inbox (pular sem fetch). */
  ingeridos: Set<string>;
  /** gmail_message_id → avaliação anterior sem match (reusar sem fetch). */
  memoMap: Map<string, MemoAvaliacao>;
};

let memoFlagCache: { v: boolean; exp: number } | null = null;
const MEMO_FLAG_TTL_MS = 60_000;

/** Flag da memória de avaliação. Falha lendo = OFF (best-effort, byte-idêntico). */
async function flagMemoAvaliacaoOn(
  supabase: ReturnType<typeof createClient>,
): Promise<boolean> {
  const now = Date.now();
  if (memoFlagCache && memoFlagCache.exp > now) return memoFlagCache.v;
  try {
    const { data } = await supabase
      .from("feature_flags")
      .select("enabled")
      .eq("key", "gmail_poll_memo_avaliacao_ativo")
      .maybeSingle();
    const v = (data as { enabled?: boolean } | null)?.enabled === true;
    memoFlagCache = { v, exp: now + MEMO_FLAG_TTL_MS };
    return v;
  } catch {
    return false;
  }
}

/** Set dos gmail_message_ids já ingeridos em messages_inbox (1 query/chunk). */
async function prefetchIngeridos(
  supabase: ReturnType<typeof createClient>,
  ids: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const chunk of particionarEmChunks(ids, 50)) {
    // gmail_message_id vive no jsonb raw_payload; o select aliased faz a
    // inferência do PostgREST recursionar (TS2589). Escape-hatch localizado,
    // igual aos casts de data no resto do arquivo.
    // deno-lint-ignore no-explicit-any
    const { data } = await (supabase.from("messages_inbox") as any)
      .select("gmail_message_id:raw_payload->>gmail_message_id")
      .filter(
        "raw_payload->>gmail_message_id",
        "in",
        `(${chunk.map((t) => `"${t}"`).join(",")})`,
      );
    for (const id of setDeGmailMessageIds((data ?? []) as Array<{ gmail_message_id?: string | null }>)) {
      out.add(id);
    }
  }
  return out;
}

/** Map gmail_message_id → avaliação anterior sem match, por caixa (1 query/chunk). */
async function prefetchMemo(
  supabase: ReturnType<typeof createClient>,
  operadorId: string,
  ids: string[],
): Promise<Map<string, MemoAvaliacao>> {
  const map = new Map<string, MemoAvaliacao>();
  for (const chunk of particionarEmChunks(ids, 50)) {
    // tabela nova (fora dos tipos gerados); evita TS2589 na inferência do
    // builder. Ver prefetchIngeridos.
    // deno-lint-ignore no-explicit-any
    const { data } = await (supabase.from("gmail_poll_msg_avaliada") as any)
      .select("gmail_message_id, nf_extraida, dominio_remetente, scan_divergente_enfileirado")
      .eq("operador_id", operadorId)
      .in("gmail_message_id", chunk);
    for (const [k, v] of mapaMemoAvaliacao((data ?? []) as MemoAvaliacaoRow[])) map.set(k, v);
  }
  return map;
}

/** Grava/atualiza a avaliação de uma mensagem ainda não-casada. */
async function upsertMemoAvaliacao(
  supabase: ReturnType<typeof createClient>,
  operadorId: string,
  gmailMessageId: string,
  gmailThreadId: string,
  nf: string | null,
  dominio: string | null,
  scanEnfileirado: boolean,
): Promise<void> {
  // tabela nova (fora dos tipos gerados); evita TS2589 na inferência do builder.
  // deno-lint-ignore no-explicit-any
  await (supabase.from("gmail_poll_msg_avaliada") as any).upsert(
    {
      operador_id: operadorId,
      gmail_message_id: gmailMessageId,
      gmail_thread_id: gmailThreadId,
      nf_extraida: nf,
      dominio_remetente: dominio,
      scan_divergente_enfileirado: scanEnfileirado,
      ultima_avaliacao_em: new Date().toISOString(),
    },
    { onConflict: "operador_id,gmail_message_id" },
  );
}

async function processarOperador(
  supabase: ReturnType<typeof createClient>,
  op: Operador,
  summary: PollSummary,
  deadlineMs: number = Number.MAX_SAFE_INTEGER,
): Promise<void> {
  const creds = await loadOperadorGmailCreds(supabase, op.id);
  if (!creds) {
    summary.erros.push("sem creds Gmail");
    return;
  }

  const accessToken = await refreshGmailAccessToken(supabase, op.id, creds);

  // Garante label (cacheia ID em gmail_polling_state)
  const { data: stateRow } = await supabase
    .from("gmail_polling_state")
    .select("cockpit_label_id")
    .eq("operador_id", op.id)
    .maybeSingle();

  let labelId = (stateRow as { cockpit_label_id?: string } | null)?.cockpit_label_id ?? null;
  if (!labelId) {
    labelId = await garantirLabelCockpitTracked(accessToken);
    await supabase.from("gmail_polling_state").upsert({
      operador_id: op.id,
      cockpit_label_id: labelId,
    });
  }

  // Lista mensagens não lidas filtradas por label
  const msgs = await listarMensagensNaoLidas(accessToken);
  summary.msgs_listadas = msgs.length;

  // Matheus 2026-07-22 (NF 1504049): prefetch EM LOTE dos lookups de thread.
  // Antes eram 2 queries de banco POR MENSAGEM (cards_emails_outbound +
  // messages_inbox âncora) — até 1000 roundtrips por caixa a cada rodada,
  // um dos combustíveis do WORKER_RESOURCE_LIMIT. Agora: 1 query em chunks
  // por tabela, reduzida em memória pro par thread→card mais recente.
  const threadIds = [...new Set(msgs.map((m) => m.threadId).filter(Boolean))];
  const threadCard = new Map<string, string>();
  // Revisão pré-merge 2026-07-22: se QUALQUER chunk do prefetch falhar, NÃO
  // usar o mapa (incompleto = pareceria "sem match" e a resposta do cliente
  // seria ignorada em silêncio). prefetchFalhou=true → processarMensagem
  // volta pros lookups por-mensagem (mais lento, sempre correto) nesta rodada,
  // e o erro fica visível em summary.erros.
  let prefetchFalhou = false;
  {
    type OutRow = { card_id: string | null; gmail_thread_id: string | null; sent_at: string | null };
    const outRows: OutRow[] = [];
    // Chunks de 50 + ORDER sent_at DESC: se o max-rows do PostgREST (1000)
    // truncar, caem as linhas MAIS ANTIGAS — "mais recente vence" preservado.
    for (const chunk of particionarEmChunks(threadIds, 50)) {
      const { data, error } = await supabase
        .from("cards_emails_outbound")
        .select("card_id, gmail_thread_id, sent_at")
        .in("gmail_thread_id", chunk)
        .order("sent_at", { ascending: false });
      if (error) {
        prefetchFalhou = true;
        summary.erros.push(`prefetch outbound: ${error.message}`);
        break;
      }
      outRows.push(...((data ?? []) as OutRow[]));
    }
    for (const [k, v] of mapaMaisRecentePorChave(outRows, (r) => r.gmail_thread_id, (r) => r.card_id, (r) => r.sent_at)) {
      threadCard.set(k, v);
    }

    // Âncoras de thread adotada (scan-email-pre-card) só pros threads que
    // ainda não casaram por outbound — mesma precedência do fluxo antigo.
    const restantes = threadIds.filter((t) => !threadCard.has(t));
    type InboxRow = { card_id: string | null; gmail_thread_id: string | null; recebido_em: string | null };
    const inboxRows: InboxRow[] = [];
    for (const chunk of particionarEmChunks(prefetchFalhou ? [] : restantes, 50)) {
      // deno-lint-ignore no-explicit-any — o encadeamento select+filter em
      // coluna JSON estoura a inferência do postgrest-js (TS2589)
      const { data, error } = await (supabase.from("messages_inbox") as any)
        .select("card_id, gmail_thread_id:raw_payload->>gmail_thread_id, recebido_em")
        .filter("raw_payload->>gmail_thread_id", "in", `(${chunk.map((t) => `"${t}"`).join(",")})`)
        .not("card_id", "is", null)
        .order("recebido_em", { ascending: false });
      if (error) {
        prefetchFalhou = true;
        summary.erros.push(`prefetch ancora inbox: ${error.message}`);
        break;
      }
      inboxRows.push(...((data ?? []) as InboxRow[]));
    }
    for (const [k, v] of mapaMaisRecentePorChave(inboxRows, (r) => r.gmail_thread_id, (r) => r.card_id, (r) => r.recebido_em)) {
      if (!threadCard.has(k)) threadCard.set(k, v);
    }
  }

  // Revisão pré-merge 2026-07-22: detecção de resposta da operadora roda
  // ANTES do loop de mensagens. Gated por budget no fim, caixa pesada (que
  // por definição chega ao fim já estourada) NUNCA rodava a detecção e cards
  // ficavam presos em CLIENTE RESPONDEU. Custo é pequeno (só cards nesse
  // estado); a ingestão desta rodada só é varrida na próxima — aceitável.
  try {
    const revertidos = await detectarRespostasOperadoraNoGmail(supabase, accessToken, op.id);
    summary.cards_revertidos_por_resposta_operadora = revertidos;
  } catch (err) {
    const msgErr = err instanceof Error ? err.message : String(err);
    summary.erros.push(`detect-resposta-operadora: ${msgErr}`);
  }

  // Causa-2 (Matheus 2026-07-23): prefetch da memória de avaliação, pra não
  // re-fetchar no Gmail a mesma msg não-casada toda rodada. Gated por flag —
  // OFF (memoCtx = undefined) = comportamento byte-idêntico ao atual.
  let memoCtx: MemoCtx | undefined;
  if (await flagMemoAvaliacaoOn(supabase)) {
    const ids = msgs.map((m) => m.id);
    try {
      const [ingeridos, memoMap] = await Promise.all([
        prefetchIngeridos(supabase, ids),
        prefetchMemo(supabase, op.id, ids),
      ]);
      memoCtx = { ingeridos, memoMap };
    } catch (err) {
      // Prefetch do memo falhou → segue sem ele (comportamento atual). Nunca
      // derruba a rodada por causa da otimização.
      summary.erros.push(`prefetch memo: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let msgsRestantes = 0;
  for (let idx = 0; idx < msgs.length; idx++) {
    const m = msgs[idx]!;
    if (Date.now() > deadlineMs) {
      // Rodada parcial deliberada: o que sobrou continua não-lido e será
      // re-listado. O upsert de gmail_polling_state abaixo AINDA roda —
      // checkpoint sempre, pra caixa nunca mais "morrer sem deixar rastro".
      msgsRestantes = msgs.length - idx;
      summary.erros.push(`budget: rodada parcial, ${msgsRestantes} msgs ficam pra próxima`);
      break;
    }
    try {
      const processed = await processarMensagem(
        supabase,
        accessToken,
        op.id,
        op.email,
        m.id,
        m.threadId,
        prefetchFalhou ? undefined : threadCard,
        memoCtx,
      );
      if (processed) summary.msgs_vinculadas++;
      else summary.msgs_ignoradas++;
    } catch (err) {
      const msgErr = err instanceof Error ? err.message : String(err);
      summary.erros.push(`msg ${m.id}: ${msgErr}`);
    }
  }

  // Caio 2026-05-08: detecta respostas que a operadora mandou direto pelo
  // Gmail (fora do Cockpit). Pra cada card em CLIENTE RESPONDEU, checa o
  // thread; se há SENT após cliente_respondeu_em → reverte pra
  // AGUARDANDO_CLIENTE pra esperar próximo retorno do cliente.
  // Rodada parcial NÃO carimba sucesso limpo (revisão pré-merge 2026-07-22):
  // last_success_at só avança em rodada completa, e o backlog fica visível em
  // last_error — senão o monitoramento via gmail_polling_state mostra tudo
  // saudável enquanto a caixa pesada drena devagar. last_poll_at avança
  // sempre (rodízio justo entre caixas).
  const rodadaCompleta = msgsRestantes === 0;
  await supabase.from("gmail_polling_state").upsert({
    operador_id: op.id,
    last_poll_at: new Date().toISOString(),
    // Rodada completa avança last_success_at mesmo se o prefetch caiu no
    // fallback por-mensagem — os dados saíram corretos, só mais lentos.
    ...(rodadaCompleta ? { last_success_at: new Date().toISOString() } : {}),
    last_error: !rodadaCompleta
      ? `backlog: ${msgsRestantes} msgs não processadas nesta rodada (budget)`
      : (prefetchFalhou
        ? `aviso: prefetch falhou, fallback por-mensagem usado (ver logs da rodada)`
        : null),
    msgs_processadas_total: (await getCurrentTotal(supabase, op.id)) + summary.msgs_vinculadas,
  });
}

async function getCurrentTotal(
  supabase: ReturnType<typeof createClient>,
  operadorId: string,
): Promise<number> {
  const { data } = await supabase
    .from("gmail_polling_state")
    .select("msgs_processadas_total")
    .eq("operador_id", operadorId)
    .maybeSingle();
  return (data as { msgs_processadas_total?: number } | null)?.msgs_processadas_total ?? 0;
}

/**
 * Caio 2026-05-08: detecta respostas que a operadora mandou direto pelo Gmail
 * (fora do Cockpit). Quando Larissa responde manualmente um cliente que tinha
 * acionado a aba CLIENTE RESPONDEU, o card precisa voltar pra AGUARDANDO_CLIENTE
 * pra esperar o próximo retorno do cliente. Sem esse detector, card fica preso
 * em CLIENTE RESPONDEU mesmo após Larissa ter respondido.
 *
 * Como funciona: pra cada card em AGUARDANDO_VALIDACAO_HUMANA com
 * cliente_respondeu_em, busca o thread no Gmail e procura mensagens com label
 * SENT cuja internalDate > cliente_respondeu_em E que NÃO sejam outbound do
 * Cockpit (filtra pelo gmail_message_id em cards_emails_outbound).
 *
 * Idempotência: revert zera cliente_respondeu_em → próximo ciclo o card sai
 * dos candidatos → no-op. Próximo retorno do cliente re-aciona o flow normal
 * (vinculador + IA sugere oc).
 */
async function detectarRespostasOperadoraNoGmail(
  supabase: ReturnType<typeof createClient>,
  accessToken: string,
  operadorId: string,
): Promise<number> {
  const { data: cardsRaw } = await supabase
    .from("cards")
    .select("id, nf, cliente_respondeu_em, cod_ultima_ocorrencia")
    .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
    .eq("assigned_operator_id", operadorId)
    .not("cliente_respondeu_em", "is", null);

  const cards = (cardsRaw ?? []) as Array<{
    id: string;
    nf: string | null;
    cliente_respondeu_em: string;
    cod_ultima_ocorrencia: number | null;
  }>;
  if (cards.length === 0) return 0;

  let revertidos = 0;

  for (const card of cards) {
    const { data: outboundRaw } = await supabase
      .from("cards_emails_outbound")
      .select("gmail_thread_id, gmail_message_id")
      .eq("card_id", card.id)
      .order("sent_at", { ascending: false });

    const outbound = (outboundRaw ?? []) as Array<{
      gmail_thread_id: string | null;
      gmail_message_id: string | null;
    }>;
    if (outbound.length === 0) continue;

    const threadId = outbound[0].gmail_thread_id;
    if (!threadId) continue;
    const cockpitMsgIds = new Set(
      outbound.map((o) => o.gmail_message_id).filter((id): id is string => Boolean(id)),
    );

    let thread: { id: string; messages?: Array<{ id: string; labelIds?: string[]; internalDate?: string }> };
    try {
      thread = await getThreadMin(accessToken, threadId);
    } catch (err) {
      console.warn(`[detect-resposta-operadora] thread.get ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Caio 2026-05-08: gate baseado em ordem dos eventos na thread (mais
    // robusto que `SENT.internalDate > cliente_respondeu_em`, que falha se
    // Larissa responde nos segundos antes da nossa flag ser setada). Lógica:
    // se a ÚLTIMA mensagem SENT-não-Cockpit é POSTERIOR à última INBOX,
    // significa que a operadora foi a última a falar → cliente está com a
    // bola, revert pra AGUARDANDO_CLIENTE.
    const msgs = (thread.messages ?? []).slice().sort((a, b) =>
      parseInt(a.internalDate ?? "0", 10) - parseInt(b.internalDate ?? "0", 10)
    );
    const lastInboxTs = msgs
      .filter((m) => m.labelIds?.includes("INBOX"))
      .map((m) => parseInt(m.internalDate ?? "0", 10))
      .reduce((acc, t) => (t > acc ? t : acc), 0);
    if (lastInboxTs === 0) continue; // thread sem reply de cliente, nada a reverter

    const respostaOperadora = [...msgs].reverse().find((m) => {
      if (!m.labelIds?.includes("SENT")) return false;
      if (cockpitMsgIds.has(m.id)) return false;
      return parseInt(m.internalDate ?? "0", 10) > lastInboxTs;
    });

    if (!respostaOperadora) continue;

    // Caio 2026-06-22 (INVARIANTE — bug NF 66820): AGUARDANDO_CLIENTE só pode
    // conter cards com oc=54. Mesmo que a operadora tenha respondido o cliente
    // (aqui, direto no Gmail, fora do Cockpit), se a última ocorrência do card
    // NÃO é 54 ele está em AGUARDANDO VOCÊ por uma oc de relacionamento ainda
    // não lançada no SSW. Responder o email não trata essa oc — então NÃO
    // reverte pra AGUARDANDO_CLIENTE (gêmeo do guard no responder-email-cliente).
    // Card permanece locked em AGUARDANDO VOCÊ até a operadora lançar a oc de
    // fato. Sem state change → sem evento (o card segue no SELECT a cada poll).
    if (card.cod_ultima_ocorrencia !== 54) continue;

    const { error: updErr } = await supabase
      .from("cards")
      .update({
        state: "AGUARDANDO_CLIENTE",
        lock_aguardando_validacao: false,
        cliente_respondeu_em: null,
        ia_sugestao_oc_resposta: null,
      })
      .eq("id", card.id);

    if (updErr) {
      console.warn(`[detect-resposta-operadora] UPDATE card ${card.id}: ${updErr.message}`);
      continue;
    }

    await supabase.from("card_events").insert({
      card_id: card.id,
      event_type: "OperadoraRespondeuClienteViaGmail",
      actor_type: "system",
      actor_id: "gmail-poll-inbox",
      payload: {
        gmail_message_id: respostaOperadora.id,
        gmail_thread_id: threadId,
        internal_date: respostaOperadora.internalDate,
        observacao: "Operadora respondeu cliente fora do Cockpit (Gmail direto). Card volta pra AGUARDANDO_CLIENTE; próxima resposta do cliente re-aciona aba CLIENTE RESPONDEU.",
      },
    });

    revertidos++;
  }

  return revertidos;
}

/**
 * Processa 1 mensagem: lookup card_id, INSERT messages_inbox, mark as read.
 * Retorna true se vinculou ao card, false se ignorou (sem match em outbound).
 */
async function processarMensagem(
  supabase: ReturnType<typeof createClient>,
  accessToken: string,
  operadorId: string,
  operadorEmail: string | null,
  messageId: string,
  threadId: string,
  threadCardPrefetch?: Map<string, string>,
  memo?: MemoCtx,
): Promise<boolean> {
  // Caio 2026-05-08: lookup por thread_id ANTES de fetchar conteúdo.
  // Polling agora lista todo unread (não só label cockpit-tracked) — então
  // a maioria dos itens é email pessoal da Larissa que não tem match.
  // Pular cedo evita gastar Gmail messages.get + preserva privacidade
  // (não marcamos como lido emails que não são do Cockpit).
  // Matheus 2026-07-22: quando o chamador passa o prefetch em lote
  // (threadCardPrefetch, já com outbound + âncora adotada consolidados),
  // os dois lookups por-mensagem abaixo são pulados — era 1 roundtrip de
  // banco por mensagem, combustível do WORKER_RESOURCE_LIMIT.
  let cardId: string | null = null;
  let matchVia: "thread_id" | "fallback_nf_dominio" | null = null;
  if (threadId && threadCardPrefetch) {
    cardId = threadCardPrefetch.get(threadId) ?? null;
    if (cardId) matchVia = "thread_id";
  } else if (threadId) {
    const { data } = await supabase
      .from("cards_emails_outbound")
      .select("card_id")
      .eq("gmail_thread_id", threadId)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    cardId = (data as { card_id?: string } | null)?.card_id ?? null;
    if (cardId) matchVia = "thread_id";
  }

  // Caio 2026-06-22: thread pré-existente ADOTADA (scan-email-pre-card) ancora
  // o thread_id em messages_inbox — e pode não ter outbound do Cockpit. Casa
  // também por aí pra capturar as próximas respostas do cliente nessa thread.
  if (!cardId && threadId && !threadCardPrefetch) {
    const { data } = await supabase
      .from("messages_inbox")
      .select("card_id")
      .eq("raw_payload->>gmail_thread_id", threadId)
      .not("card_id", "is", null)
      .order("recebido_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    cardId = (data as { card_id?: string } | null)?.card_id ?? null;
    if (cardId) matchVia = "thread_id";
  }

  // Caio 2026-05-21 (NF 1008919): fallback quando cliente abre email NOVO
  // em vez de "Responder" (ex: PRATI tem sistema interno que abre subject
  // estruturado "CLIENTE NNN NOTA NNN OC NNN - Assunto: ..."). Sem thread_id
  // match, ANTES o gmail-poll descartava silenciosamente. Agora fetcha
  // metadata da mensagem, extrai NF do subject, e tenta match por
  // (NF + domínio remetente) em outbounds das últimas 48h.
  //
  // Risco: vincular mensagem unsolicited. Mitigação: requer AMBOS NF
  // mencionada E domínio bater contra outbound real do Cockpit.
  // Auditável via raw_payload.match_via = 'fallback_nf_dominio'.
  if (!cardId) {
    // Causa-2 (Matheus 2026-07-23): a mesma msg não-casada era re-fetchada no
    // Gmail (getMensagemMetadata) A CADA rodada — backlog que nunca drenava
    // (sac 436, julia 427, larissa 410...). Com a memória de avaliação (flag
    // gmail_poll_memo_avaliacao_ativo): (a) já ingerida em messages_inbox →
    // pula sem fetch; (b) já avaliada sem match → reusa nf/domínio cacheados e
    // re-roda SÓ o match no banco (late-binding preservado), sem fetch e sem
    // re-enfileirar o scan divergente. memo undefined (flag OFF ou prefetch
    // caído) = comportamento byte-idêntico ao anterior. Ver ADR 0015.
    if (memo && memo.ingeridos.has(messageId)) {
      await marcarComoLida(accessToken, messageId).catch(() => {});
      return false;
    }
    const memoHit = memo ? memo.memoMap.get(messageId) : undefined;

    let subject: string | null = null;
    let nfExtraida: string | null = null;
    let dominio: string | null = null;
    let recebidoMs: number | null = null;
    let scanEnfileirado = memoHit?.scanEnfileirado ?? false;

    if (memoHit) {
      // Reusa a avaliação anterior — SEM roundtrip ao Gmail.
      nfExtraida = memoHit.nf;
      dominio = memoHit.dominio;
    } else {
      const metadata = await getMensagemMetadata(accessToken, messageId).catch(() => null);
      if (metadata) {
        subject = getHeader(metadata, "Subject") ?? "";
        const from = parseEmailFromHeader(getHeader(metadata, "From") ?? "");
        const nfMatch = subject.match(/NF\s*(\d{4,9})/i);
        nfExtraida = nfMatch?.[1] ?? null;
        dominio = from.includes("@") ? from.split("@")[1]!.toLowerCase() : null;
        recebidoMs = metadata.internalDate ? Number(metadata.internalDate) : null;
      }
    }

    // Match (NF no subject + domínio remetente == outbound 48h). Roda toda
    // rodada, INCLUSIVE na re-avaliação, pra preservar o late-binding do
    // fallback (o outbound pode aparecer depois da mensagem do cliente).
    if (nfExtraida && dominio) {
      const { data: outFallback } = await supabase
        .from("cards_emails_outbound")
        .select("card_id, to_email, sent_at, cards!inner(nf)")
        .eq("cards.nf", nfExtraida)
        .ilike("to_email", `%@${dominio}`)
        .gte("sent_at", new Date(Date.now() - 48 * 3600_000).toISOString())
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const fbCardId = (outFallback as { card_id?: string } | null)?.card_id ?? null;
      if (fbCardId) {
        cardId = fbCardId;
        matchVia = "fallback_nf_dominio";
        console.log(
          `[gmail-poll] match fallback: NF=${nfExtraida} dominio=${dominio} → card=${fbCardId}`,
        );
      }
    }

    // Opção 1 (Caio 2026-06-23): e-mail NOVO que não casou → pode ser uma
    // tratativa DIVERGENTE de um card ativo do operador (cliente/base abriu
    // outra thread). Enfileira um scan FOCADO nessa thread (gated por flag
    // dentro do helper). Só "daqui pra frente" e enqueue-once: roda apenas na
    // PRIMEIRA avaliação (subject !== null ⇒ metadata fresca), nunca na
    // re-avaliação cacheada — o helper não precisa re-enfileirar toda rodada.
    if (!cardId && subject !== null) {
      await surfarThreadDivergenteSeCasar(supabase, {
        operadorId,
        subject,
        threadId,
        recebidoMs,
      });
      scanEnfileirado = true;
    }

    // Grava/atualiza a memória (só com flag ON e enquanto NÃO casou — ao casar,
    // vira row em messages_inbox e o prefetch de ingeridos passa a cobrir).
    if (memo && !cardId) {
      await upsertMemoAvaliacao(
        supabase,
        operadorId,
        messageId,
        threadId,
        nfExtraida,
        dominio,
        scanEnfileirado,
      ).catch(() => {});
    }
  }

  if (!cardId) {
    // Caio 2026-06-16: RAMO NOVO — criação antecipada de card a partir do
    // e-mail automático do SSW (sswemail@ssw.inf.br). Só ativa pra caixa do
    // operador COCKPIT + flag ON + NF na whitelist (gates dentro do helper).
    // try/catch blindado: NUNCA pode derrubar o polling de produção dos outros
    // operadores. O helper só resolve (não lança); em erro loga em
    // email_ssw_eventos. handled=true → era e-mail do SSW, marca como lida.
    if ((operadorEmail ?? "").toLowerCase() === "cockpit@salexpress.com.br") {
      try {
        const meta = await getMensagemMetadata(accessToken, messageId).catch(() => null);
        const fromSsw = meta ? (getHeader(meta, "From") ?? "") : "";
        if (fromSsw.toLowerCase().includes("sswemail@ssw.inf.br")) {
          const fullMsg = await getMensagemFull(accessToken, messageId);
          const corpoSsw = extrairTexto(fullMsg);
          const r = await tentarCriarCardViaSswEmail(supabase, {
            operadorId,
            operadorEmail,
            gmailMessageId: messageId,
            gmailThreadId: threadId,
            fromHeader: getHeader(fullMsg, "From") ?? fromSsw,
            corpo: corpoSsw,
            env: Deno.env.toObject(),
          });
          if (r.handled) {
            await marcarComoLida(accessToken, messageId).catch(() => {});
            console.log(
              `[gmail-poll][ssw-card] msg=${messageId} cards_criados=${r.cardsCriados}`,
            );
            return false;
          }
        }
      } catch (err) {
        // Blindagem final: erro aqui jamais propaga pro loop do operador.
        console.warn(
          `[gmail-poll][ssw-card] erro isolado msg=${messageId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Thread não-tracked (email pessoal da Larissa ou thread sem outbound
    // do Cockpit). Não marca como lida, não fetcha conteúdo full, não
    // polui messages_inbox. Próximo polling re-lista mas custo é só list.
    return false;
  }

  const msg = await getMensagemFull(accessToken, messageId);

  // Mensagens com label SENT são emails enviados pela própria operadora
  // (ex: Larissa enviou via Cockpit). Não capturar — só queremos respostas
  // do cliente. Marca como lida pra não re-listar.
  if (msg.labelIds?.includes("SENT")) {
    await marcarComoLida(accessToken, messageId).catch(() => {});
    return false;
  }

  const messageIdHeader = normalizeMessageId(getHeader(msg, "Message-ID"));
  const inReplyTo = normalizeMessageId(getHeader(msg, "In-Reply-To"));
  const referencesHeader = getHeader(msg, "References");
  const fromHeader = getHeader(msg, "From") ?? "(unknown)";
  const subjectHeader = getHeader(msg, "Subject") ?? "";
  // Caio 2026-05-27 (NF 647901 DURAFA): preserva To/Cc da mensagem inbound
  // pra que responder-email-cliente possa pré-popular CC com os endereços
  // que o cliente adicionou ao responder. Antes só salvávamos `from` — quando
  // cliente adicionava transporte@isapa.com.br em CC, o sistema perdia.
  const toHeader = getHeader(msg, "To") ?? "";
  const ccHeader = getHeader(msg, "Cc") ?? "";

  // Idempotência: se já temos essa mensagem em messages_inbox, pula
  if (messageIdHeader) {
    const { data: existing } = await supabase
      .from("messages_inbox")
      .select("id")
      .eq("message_id_header", messageIdHeader)
      .limit(1)
      .maybeSingle();
    if (existing) {
      await marcarComoLida(accessToken, messageId).catch(() => {});
      return false;
    }
  }

  const remetente = parseEmailFromHeader(fromHeader);

  // Caio 2026-06-02 (NF 5826 MIX MOTO): bounces do mailer-daemon/postmaster
  // estavam sendo vinculados ao card como se fossem resposta do cliente.
  // Vinculador setava cliente_respondeu_em → card aparecia em "CLIENTE
  // RESPONDEU" mesmo sem cliente ter respondido nada. interpretador-resposta
  // classificava como bounce DEPOIS mas dano já estava feito. Filtro aqui
  // impede que bounce vire row em messages_inbox.
  const remetenteLower = remetente.toLowerCase();
  const subjectLower = subjectHeader.toLowerCase();
  const ehBounce =
    remetenteLower.startsWith("mailer-daemon@") ||
    remetenteLower.startsWith("postmaster@") ||
    /mensagem n[ãa]o entreg|undelivered mail|delivery status notification|mail delivery (failed|subsystem)|returned to sender|n[ãa]o foi entregue|delivery has failed/i.test(subjectLower);
  if (ehBounce) {
    // Momento em que o DSN foi gerado (internalDate do Gmail), não o de
    // processamento — usado no banner e na comparação com outbound.
    const bounceTs = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date();

    // Caio 2026-06-02: registra bounce no card pra front mostrar banner amarelo.
    // Caio 2026-07-01 (bug B, NF 575330 HDL): extração via parser de NDR — lê o
    // part `message/delivery-status` (Diagnostic-Code / Final-Recipient) PRIMEIRO,
    // com fallback GUARDADO contra blob hex. Ver parse-bounce-ndr.ts.
    const bounce = parseBounceNdr(flattenPartsDecoded(msg));
    const payload = {
      destinatario: bounce.destinatario,
      motivo_smtp: bounce.motivo_smtp,
      status_code: bounce.status_code,
      diagnostic_raw: bounce.diagnostic_raw,
      fonte: bounce.fonte,
      gmail_message_id: messageId,
      subject_original: subjectHeader,
      detectado_em: bounceTs.toISOString(),
    };

    // Item 4a: IDEMPOTÊNCIA por gmail_message_id (detectado OU ignorado) — não
    // re-registra evento/banner do mesmo bounce.
    const { data: jaRegistrado } = await supabase
      .from("card_events")
      .select("id")
      .eq("card_id", cardId)
      .in("event_type", ["BounceDetectado", "BounceDetectadoIgnorado"])
      .eq("payload->>gmail_message_id", messageId)
      .limit(1)
      .maybeSingle();

    // Item 4b (Caio 2026-07-01, refino): banner OBSOLETO por outbound posterior.
    // A RECONCILIAÇÃO roda ANTES do early-return da idempotência — senão um bounce
    // já registrado (ex.: HDL) nunca chegaria na limpeza e o banner stale ficaria
    // pra sempre. A limpeza do banner é idempotente (null→null = no-op); o evento
    // BounceDetectadoIgnorado só é gravado na 1ª vez (guard jaRegistrado).
    // OBS: alcança só bounces (re)processados por este poll; banners já-lidos que
    // nunca voltam são limpos pelo retroativo audits/retroativo-bounce-banner-stale.
    const { data: outboundPosterior } = await supabase
      .from("cards_emails_outbound")
      .select("id, sent_at")
      .eq("card_id", cardId)
      .gt("sent_at", bounceTs.toISOString())
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (outboundPosterior) {
      const sentAt = (outboundPosterior as { sent_at: string }).sent_at;
      await supabase
        .from("cards")
        .update({ ultimo_bounce_em: null, ultimo_bounce_payload: null })
        .eq("id", cardId)
        .lt("ultimo_bounce_em", sentAt);
      if (!jaRegistrado) {
        await supabase.from("card_events").insert({
          card_id: cardId,
          event_type: "BounceDetectadoIgnorado",
          actor_type: "system",
          actor_id: "gmail-poll-inbox",
          payload: { ...payload, motivo_ignorado: "outbound posterior ao bounce", outbound_sent_at: sentAt },
        });
      }
      console.log(`[gmail-poll] bounce IGNORADO/limpo card=${cardId} (outbound posterior em ${sentAt})`);
      await marcarComoLida(accessToken, messageId).catch(() => {});
      return false;
    }

    // Sem outbound posterior: aplica a idempotência normal.
    if (jaRegistrado) {
      await marcarComoLida(accessToken, messageId).catch(() => {});
      return false;
    }

    await supabase
      .from("cards")
      .update({
        ultimo_bounce_em: bounceTs.toISOString(),
        ultimo_bounce_payload: payload,
      })
      .eq("id", cardId);
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "BounceDetectado",
      actor_type: "system",
      actor_id: "gmail-poll-inbox",
      payload,
    });
    console.log(
      `[gmail-poll] bounce registrado card=${cardId}: from=${remetente} dest=${payload.destinatario} motivo=${payload.motivo_smtp?.slice(0, 80)}`,
    );
    await marcarComoLida(accessToken, messageId).catch(() => {});
    return false;
  }

  const conteudo = extrairTexto(msg);

  const { data: inboxRow, error: insErr } = await supabase
    .from("messages_inbox")
    .insert({
      card_id: cardId,
      canal: "email",
      remetente,
      conteudo,
      message_id_header: messageIdHeader,
      in_reply_to_header: inReplyTo,
      references_header: referencesHeader,
      raw_payload: {
        gmail_message_id: messageId,
        gmail_thread_id: threadId,
        from: fromHeader,
        // Caio 2026-05-27 (NF 647901 DURAFA): preserva To/Cc da mensagem
        // inbound. Quando cliente respondeu adicionando transporte@isapa
        // em CC, o sistema perdia esses endereços e a próxima resposta do
        // operador saía só pro remetente original.
        to: toHeader,
        cc: ccHeader,
        subject: subjectHeader,
        operador_id: operadorId,
        origem: "gmail-poll-inbox",
        // Caio 2026-05-21: pra auditoria de fallback de match.
        // thread_id = match normal (cliente respondeu o thread original).
        // fallback_nf_dominio = cliente abriu email novo (caso PRATI NF 1008919);
        //   match via (NF no subject + domínio remetente == outbound 48h).
        match_via: matchVia,
      },
      processing_status: "pending",
    })
    .select("id, recebido_em")
    .single();

  if (insErr) throw new Error(`INSERT messages_inbox: ${insErr.message}`);

  // Enfileira em pgmq.agent_intake — triador → vinculador → IA.
  // Mesmo padrão usado pelo ingestor Postmark (ingestor/index.ts:108).
  const { error: enqErr } = await supabase.rpc("enqueue_to_pgmq", {
    queue_name: "agent_intake",
    payload: {
      message_id: (inboxRow as { id: string }).id,
      canal: "email",
      remetente,
      recebido_em: (inboxRow as { recebido_em: string }).recebido_em,
    },
  });
  if (enqErr) {
    console.warn(`enqueue agent_intake falhou (msg ${(inboxRow as { id: string }).id}): ${enqErr.message}`);
  }

  // Caio 2026-07-21 (onboarding Karoline): se o card foi REATRIBUÍDO (dono ≠ dono
  // da caixa que capturou), encaminha uma cópia da resposta pra caixa Gmail do novo
  // dono. BLINDADO: erro aqui jamais derruba o poll (igual ssw-card/scan divergente).
  // Gated por feature_flags('email_forward_reatribuido_ativo') dentro do helper.
  try {
    const fwd = await encaminharRespostaSeReatribuido({
      supabase,
      pollingOperadorId: operadorId,
      cardId,
      gmailMessageId: messageId,
      remetenteCliente: remetente,
      subjectOriginal: subjectHeader,
      conteudo,
    });
    if (fwd.encaminhado) {
      console.log(`[gmail-poll][fwd] card=${cardId} msg=${messageId}: ${fwd.motivo}`);
    }
  } catch (err) {
    console.warn(
      `[gmail-poll][fwd] erro isolado card=${cardId} msg=${messageId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Caio 2026-05-12 (NF 920161): captura anexos do cliente. Upload pro
  // bucket email_anexos com origem='inbound' + message_inbox_id pra Larissa
  // poder reusar (anexar em SSW, baixar). Sem isso ela precisa abrir Gmail.
  // INV-025 (NF 1486931): ignora imagem embutida no corpo (assinatura/logo
  // tipo `image001.jpg`) quando coexiste um anexo real. Sem anexo real, mantém
  // (foto colada no corpo — NF 647384). Ver selecionarAnexosParaSalvar.
  const { salvar: anexos, ignorados: anexosInline } = selecionarAnexosParaSalvar(
    extrairAnexos(msg),
  );
  if (anexosInline.length > 0) {
    console.log(
      `ignorando ${anexosInline.length} anexo(s) inline do corpo (assinatura) ` +
        `pois há anexo real: ${anexosInline.map((a) => a.filename).join(", ")}`,
    );
  }
  const ANEXO_MAX_BYTES = 10 * 1024 * 1024; // 10MB
  // Dedup intra-card (NF 1486931 capturou o MESMO PDF 3x, de 3 mensagens da
  // thread que citavam o anexo). Chave: filename+size dos inbound já no card.
  const dedupKey = (nome: string, size: number) => `${nome}|${size}`;
  const anexosInboundExistentes = new Set<string>();
  {
    const { data: jaSalvos } = await supabase
      .from("email_anexos")
      .select("filename, size_bytes")
      .eq("card_id", cardId)
      .eq("origem", "inbound")
      .is("deletado_em", null);
    for (const r of (jaSalvos ?? []) as Array<{ filename: string; size_bytes: number }>) {
      anexosInboundExistentes.add(dedupKey(r.filename, r.size_bytes));
    }
  }
  const MIMES_PERMITIDOS = new Set([
    "application/pdf",
    "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv", "text/plain",
  ]);
  const inboxId = (inboxRow as { id: string }).id;
  const anexosSalvos: Array<{ id: string; filename: string; mime: string }> = [];
  for (const anexo of anexos) {
    if (anexo.sizeBytes > ANEXO_MAX_BYTES) {
      console.warn(`anexo ${anexo.filename} ignorado (${anexo.sizeBytes} bytes > 10MB)`);
      continue;
    }
    if (!MIMES_PERMITIDOS.has(anexo.mimeType.toLowerCase())) {
      console.warn(`anexo ${anexo.filename} ignorado (mime ${anexo.mimeType} fora da allowlist)`);
      continue;
    }
    if (anexosInboundExistentes.has(dedupKey(anexo.filename, anexo.sizeBytes))) {
      console.log(`anexo ${anexo.filename} (${anexo.sizeBytes}b) já existe no card — dedup, pulando`);
      continue;
    }
    try {
      const bytes = await baixarAttachment(accessToken, messageId, anexo.attachmentId);
      const anexoUuid = crypto.randomUUID();
      const safeFilename = anexo.filename.replace(/[^\w.\- ]/g, "_");
      const storagePath = `inbound/${inboxId}/${anexoUuid}-${safeFilename}`;
      const { error: upErr } = await supabase.storage
        .from("email_anexos")
        .upload(storagePath, bytes, { contentType: anexo.mimeType, upsert: false });
      if (upErr) {
        console.warn(`anexo ${anexo.filename} upload falhou: ${upErr.message}`);
        continue;
      }
      const { data: anexoRow, error: insErr } = await supabase
        .from("email_anexos")
        .insert({
          card_id: cardId,
          origem: "inbound",
          message_inbox_id: inboxId,
          storage_path: storagePath,
          filename: anexo.filename,
          mime_type: anexo.mimeType,
          size_bytes: bytes.byteLength,
        })
        .select("id")
        .single();
      if (insErr) {
        console.warn(`anexo ${anexo.filename} INSERT email_anexos falhou: ${insErr.message}`);
        continue;
      }
      anexosInboundExistentes.add(dedupKey(anexo.filename, bytes.byteLength));
      anexosSalvos.push({
        id: (anexoRow as { id: string }).id,
        filename: anexo.filename,
        mime: anexo.mimeType,
      });
    } catch (err) {
      console.warn(`anexo ${anexo.filename} erro: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Card_event de auditoria
  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "RespostaClienteCapturada",
    actor_type: "system",
    actor_id: "gmail-poll-inbox",
    payload: {
      gmail_message_id: messageId,
      gmail_thread_id: threadId,
      remetente,
      subject: subjectHeader,
      preview: conteudo.slice(0, 300),
      anexos_count: anexosSalvos.length,
      anexos: anexosSalvos,
    },
  });

  await marcarComoLida(accessToken, messageId).catch(() => {});
  return true;
}

/**
 * Admin: re-aplica label cockpit-tracked + marca thread como unread.
 * Próximo polling captura a mensagem da thread como se fosse nova.
 * Útil pra retroativo (ex: NF que recebeu reply antes do polling existir).
 */
async function reativarThread(
  supabase: ReturnType<typeof createClient>,
  threadId: string,
  operadorEmail: string | undefined,
): Promise<Response> {
  const query = supabase.from("operadores").select("id, email, gmail_oauth_credentials");
  const { data: ops } = operadorEmail
    ? await query.eq("email", operadorEmail).limit(1)
    : await query.not("gmail_oauth_credentials", "is", null).limit(1);

  const op = (ops?.[0] as Operador | undefined);
  if (!op) return jsonResp({ ok: false, error: "operador não encontrado" }, 404);

  const creds = await loadOperadorGmailCreds(supabase, op.id);
  if (!creds) return jsonResp({ ok: false, error: "operador sem creds Gmail" }, 400);

  const accessToken = await refreshGmailAccessToken(supabase, op.id, creds);
  const labelId = await garantirLabelCockpitTracked(accessToken);

  await supabase.from("gmail_polling_state").upsert({
    operador_id: op.id,
    cockpit_label_id: labelId,
  });

  // Aplica label + UNREAD na thread
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ addLabelIds: [labelId, "UNREAD"] }),
    },
  );
  if (!res.ok) {
    return jsonResp({
      ok: false,
      error: `Gmail threads.modify: ${res.status} ${await res.text()}`,
    }, 500);
  }

  return jsonResp({
    ok: true,
    operador_id: op.id,
    operador_email: op.email,
    thread_id: threadId,
    label_id: labelId,
    obs: "Thread reativada. Próximo polling captura.",
  }, 200);
}

async function debugInspect(
  supabase: ReturnType<typeof createClient>,
  operadorEmail?: string,
): Promise<Response> {
  // Caio 2026-05-15 (multi-operador): aceita operador_email pra debug
  // específico (ex: Duilio). Sem param, pega o primeiro com gmail_oauth.
  let query = supabase
    .from("operadores")
    .select("id, email, gmail_oauth_credentials")
    .not("gmail_oauth_credentials", "is", null);
  if (operadorEmail) query = query.eq("email", operadorEmail);
  const { data: ops } = await query.limit(1);
  const op = ops?.[0] as Operador | undefined;
  if (!op) return jsonResp({ ok: false, error: `sem operador ${operadorEmail ?? ''}` }, 404);
  const creds = await loadOperadorGmailCreds(supabase, op.id);
  if (!creds) return jsonResp({ ok: false, error: "sem creds" }, 400);
  const accessToken = await refreshGmailAccessToken(supabase, op.id, creds);
  const msgs = await listarMensagensNaoLidas(accessToken);
  const details: Array<Record<string, unknown>> = [];
  for (const m of msgs) {
    const full = await getMensagemFull(accessToken, m.id);
    details.push({
      id: m.id,
      threadId: m.threadId,
      labelIds: full.labelIds,
      from: getHeader(full, "From"),
      subject: getHeader(full, "Subject"),
      inReplyTo: normalizeMessageId(getHeader(full, "In-Reply-To")),
    });
  }
  return jsonResp({ ok: true, msgs: details }, 200);
}

async function debugInspectThread(
  supabase: ReturnType<typeof createClient>,
  threadId: string,
  operadorEmail?: string,
): Promise<Response> {
  let query = supabase
    .from("operadores")
    .select("id, email, gmail_oauth_credentials")
    .not("gmail_oauth_credentials", "is", null);
  if (operadorEmail) query = query.eq("email", operadorEmail);
  const { data: ops } = await query.limit(1);
  const op = ops?.[0] as Operador | undefined;
  if (!op) return jsonResp({ ok: false, error: `sem operador ${operadorEmail ?? ''}` }, 404);
  const creds = await loadOperadorGmailCreds(supabase, op.id);
  if (!creds) return jsonResp({ ok: false, error: "sem creds" }, 400);
  const accessToken = await refreshGmailAccessToken(supabase, op.id, creds);
  const thread = await getThreadMin(accessToken, threadId);
  return jsonResp({ ok: true, thread_id: threadId, messages: thread.messages ?? [] }, 200);
}

function parseEmailFromHeader(raw: string): string {
  // "Nome <email@x.com>" → "email@x.com"
  const m = raw.match(/<([^>]+)>/);
  if (m) return m[1]!.trim();
  return raw.trim();
}

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
