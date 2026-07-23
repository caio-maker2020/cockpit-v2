// =============================================================================
// arbitro-desfecho — Árbitro de Desfecho T+7 do Loop de Aprendizado (F3).
//
// Cron diário: pega pares sugestão×decisão com 7+ dias sem carimbo
// (v_pares_sem_desfecho), lê o estado atual do card + eventos relevantes
// pós-decisão (SÓ banco — zero chamada nova ao SSW) e grava o desfecho em
// desfechos_pares via regras puras (arbitro-desfecho-regras.ts).
//
// Body opcional: {"lote": N} (default 200, teto 500) — usado na estreia
// manual pra vencer o backlog histórico em poucas invocações.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { finishAgentRun, startAgentRun } from "../_shared/agent-runs-logger.ts";
import {
  classificarDesfecho,
  type EstadoCard,
  type EventoPosDecisao,
} from "../_shared/arbitro-desfecho-regras.ts";

const AGENT_NAME = "arbitro-desfecho";
const LOTE_DEFAULT = 200;
const LOTE_MAX = 500;
const EVENTOS_RELEVANTES = ["BastaoReabriuNFFonteRelacionamento", "BounceDetectado"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const supabaseUrl = env["SUPABASE_URL"];
  const serviceRoleKey = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const body = await req.json().catch(() => ({}));
  const lote = Math.min(LOTE_MAX, Math.max(1, Number(body?.lote) || LOTE_DEFAULT));

  const run = startAgentRun({ agentName: AGENT_NAME, stepName: "carimbar" });

  try {
    // 1. Fila: pares 7+ dias sem desfecho (mais antigos primeiro)
    const { data: paresRaw, error: paresErr } = await supabase
      .from("v_pares_sem_desfecho")
      .select(
        "fonte_tabela,fonte_id,card_id,agent_name,veredito,oc_sugerida,oc_executada,decidido_em",
      )
      .order("decidido_em", { ascending: true })
      .limit(lote);
    if (paresErr) throw new Error(`v_pares_sem_desfecho: ${paresErr.message}`);
    const pares = paresRaw ?? [];
    if (pares.length === 0) {
      await finishAgentRun(supabase, run, {
        status: "success",
        output: { carimbados: 0, fila_vazia: true },
      });
      return json({ ok: true, carimbados: 0, fila_vazia: true });
    }

    // 2. Estado atual dos cards — em BLOCOS de 80 ids: 500 UUIDs num .in()
    //    estouram o tamanho da URL do PostgREST (pego na estreia 23/07).
    const CHUNK = 80;
    const cardIds = [...new Set(pares.map((p) => p.card_id as string))];
    const cardPorId = new Map<string, EstadoCard>();
    for (let i = 0; i < cardIds.length; i += CHUNK) {
      const bloco = cardIds.slice(i, i + CHUNK);
      const { data: cardsRaw, error: cardsErr } = await supabase
        .from("cards")
        .select("id,state,cod_ultima_ocorrencia")
        .in("id", bloco);
      if (cardsErr) throw new Error(`cards: ${cardsErr.message}`);
      for (const c of cardsRaw ?? []) {
        cardPorId.set(c.id as string, {
          state: (c.state as string) ?? null,
          cod_ultima_ocorrencia: (c.cod_ultima_ocorrencia as number) ?? null,
        });
      }
    }

    // 3. Eventos RELEVANTES pós-decisão — mesmos blocos (tipos raros)
    const decididoMin = pares[0].decidido_em as string;
    const evsPorCard = new Map<string, EventoPosDecisao[]>();
    for (let i = 0; i < cardIds.length; i += CHUNK) {
      const bloco = cardIds.slice(i, i + CHUNK);
      const { data: evsRaw, error: evsErr } = await supabase
        .from("card_events")
        .select("card_id,event_type,created_at")
        .in("card_id", bloco)
        .in("event_type", EVENTOS_RELEVANTES)
        .gte("created_at", decididoMin)
        .order("created_at", { ascending: true })
        .limit(1000);
      if (evsErr) throw new Error(`card_events: ${evsErr.message}`);
      for (const e of evsRaw ?? []) {
        const lista = evsPorCard.get(e.card_id as string) ?? [];
        lista.push({
          event_type: e.event_type as string,
          created_at: e.created_at as string,
        });
        evsPorCard.set(e.card_id as string, lista);
      }
    }

    // 4. Classifica e grava (insert em bloco)
    const linhas = pares.map((p) => {
      const card = cardPorId.get(p.card_id as string) ?? null;
      const eventos = (evsPorCard.get(p.card_id as string) ?? []).filter(
        (e) => e.created_at > (p.decidido_em as string),
      );
      const r = classificarDesfecho(
        {
          veredito: p.veredito as string,
          oc_sugerida: (p.oc_sugerida as number) ?? null,
          oc_executada: (p.oc_executada as number) ?? null,
        },
        card,
        eventos,
      );
      return {
        fonte_tabela: p.fonte_tabela,
        fonte_id: p.fonte_id,
        card_id: p.card_id,
        agent_name: p.agent_name,
        veredito_par: p.veredito,
        oc_sugerida: p.oc_sugerida ?? null,
        oc_executada: p.oc_executada ?? null,
        decidido_em: p.decidido_em,
        desfecho: r.desfecho,
        arbitro: r.arbitro,
        estado_card: card?.state ?? null,
        cod_ultima_ocorrencia: card?.cod_ultima_ocorrencia ?? null,
        sinais: r.sinais,
      };
    });
    const { error: insErr } = await supabase
      .from("desfechos_pares")
      .upsert(linhas, { onConflict: "fonte_tabela,fonte_id", ignoreDuplicates: true });
    if (insErr) throw new Error(`insert desfechos: ${insErr.message}`);

    const resumo = {
      carimbados: linhas.length,
      confirma_ia: linhas.filter((l) => l.arbitro === "confirma_ia").length,
      confirma_operador: linhas.filter((l) => l.arbitro === "confirma_operador").length,
      inconclusivo: linhas.filter((l) => l.arbitro === "inconclusivo").length,
    };
    await finishAgentRun(supabase, run, { status: "success", output: resumo });
    return json({ ok: true, ...resumo });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishAgentRun(supabase, run, { status: "error", errorMessage: msg });
    return json({ ok: false, error: msg }, 500);
  }
});
