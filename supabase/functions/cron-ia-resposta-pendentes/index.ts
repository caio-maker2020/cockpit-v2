// =============================================================================
// cron-ia-resposta-pendentes — retry da IA pra cards que tiveram cliente
// respondido mas ficaram sem ia_sugestao_oc_resposta.
//
// Caio 2026-05-11 (NFs 351849 / 351077): vinculador faz chamada SÍNCRONA pro
// interpretador-resposta-cliente com timeout 30s. Se Anthropic responde lento
// ou dá erro transitório, só `console.warn` — card fica `cliente_respondeu_em`
// preenchido mas `ia_sugestao_oc_resposta=null` indefinidamente.
//
// Este cron roda a cada 1min, pega cards em AGUARDANDO_VALIDACAO_HUMANA com
// `cliente_respondeu_em != null AND ia_sugestao_oc_resposta IS NULL`, e chama
// interpretador-resposta-cliente pra cada um. Idempotente — se IA tiver sido
// preenchida entre o SELECT e o POST, simplesmente sobrescreve (= mesma).
//
// Cobertura: cards onde a chamada síncrona do vinculador falhou OU cards
// corrigidos manualmente (cliente_respondeu_em foi setado por outra rota).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const MAX_POR_RUN = 20; // limita pra evitar burst Anthropic em runs grandes
const IA_TIMEOUT_MS = 60_000;

Deno.serve(async (_req) => {
  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return resp({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Lista cards alvo: cliente respondeu mas IA não sugeriu ainda.
  const { data: cardsRaw, error: selErr } = await supabase
    .from("cards")
    .select("id, nf, cliente_respondeu_em")
    .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
    .not("cliente_respondeu_em", "is", null)
    .is("ia_sugestao_oc_resposta", null)
    .order("cliente_respondeu_em", { ascending: true })
    .limit(MAX_POR_RUN);

  if (selErr) {
    return resp({ ok: false, error: `SELECT cards: ${selErr.message}` }, 500);
  }
  const cards = (cardsRaw ?? []) as Array<{ id: string; nf: string | null; cliente_respondeu_em: string }>;

  if (cards.length === 0) {
    return resp({ ok: true, processados: 0, duration_ms: Date.now() - startedAt }, 200);
  }

  const summaries: Array<Record<string, unknown>> = [];

  for (const card of cards) {
    // 2. Pega o último message_id de messages_inbox desse card (o que deve
    //    informar a IA — geralmente a última resposta do cliente).
    const { data: msgRow } = await supabase
      .from("messages_inbox")
      .select("id, recebido_em")
      .eq("card_id", card.id)
      .order("recebido_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    const messageId = (msgRow as { id?: string } | null)?.id ?? null;

    if (!messageId) {
      summaries.push({ card_id: card.id, nf: card.nf, skip: "sem_messages_inbox" });
      continue;
    }

    // 3. Chama interpretador. Timeout 45s pra cobrir Anthropic lento.
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), IA_TIMEOUT_MS);
      const iaResp = await fetch(`${supabaseUrl}/functions/v1/interpretador-resposta-cliente`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ card_id: card.id, message_id: messageId }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const body = await iaResp.json().catch(() => null) as Record<string, unknown> | null;
      summaries.push({
        card_id: card.id,
        nf: card.nf,
        status: iaResp.status,
        ok: !!body?.["ok"],
        oc_sugerida: body?.["oc_sugerida"] ?? null,
        confianca: body?.["confianca"] ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summaries.push({ card_id: card.id, nf: card.nf, error: msg });
    }
  }

  return resp({
    ok: true,
    processados: cards.length,
    summaries,
    duration_ms: Date.now() - startedAt,
  }, 200);
});

function resp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
