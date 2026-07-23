// =============================================================================
// vincular-triador-cards — F5: casador em lote triador→card.
//
// Preenche agent_runs.card_id dos runs do triador (hoje 100% NULL) casando
// as NFs extraídas na classificação com cards criados na janela de ±6h.
// Zero toque no fluxo de ingestão — enriquecimento de telemetria por fora.
// Regras puras em _shared/vincular-triador-regras.ts.
//
// Body opcional:
//   {"lote": N}            default 300, teto 500
//   {"depois_de": iso}     cursor de started_at — backfill manual avança com
//                          ele (runs sem match NÃO travam a fila; resposta
//                          devolve ultimo_started_at pra próxima chamada)
//   {"janela_dias": N}     cron usa janela recente (só runs novos) — runs
//                          antigos sem match ficam NULL de vez, sem chute.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { finishAgentRun, startAgentRun } from "../_shared/agent-runs-logger.ts";
import {
  type CardCandidato,
  escolherCardParaRun,
  messageIdDoInput,
  nfsDoOutputTriador,
} from "../_shared/vincular-triador-regras.ts";

const AGENT_NAME = "vincular-triador-cards";
const LOTE_DEFAULT = 300;
const LOTE_MAX = 500;
const CHUNK = 80; // >~100 UUIDs/NFs num .in() estouram a URL (lição 23/07)

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
  const depoisDe: string | null = typeof body?.depois_de === "string" ? body.depois_de : null;
  const janelaDias = Number(body?.janela_dias) || null;

  const run = startAgentRun({ agentName: AGENT_NAME, stepName: "vincular" });

  try {
    // 1. Runs do triador sem card (mais antigos primeiro; cursor evita que
    //    runs sem match travem a fila do backfill)
    let q = supabase
      .from("agent_runs")
      .select("id,started_at,input,output")
      .eq("agent_name", "triador")
      .is("card_id", null)
      .order("started_at", { ascending: true })
      .limit(lote);
    if (depoisDe) q = q.gt("started_at", depoisDe);
    if (janelaDias) {
      q = q.gte(
        "started_at",
        new Date(Date.now() - janelaDias * 24 * 3600 * 1000).toISOString(),
      );
    }
    const { data: runsRaw, error: runsErr } = await q;
    if (runsErr) throw new Error(`agent_runs: ${runsErr.message}`);
    const runs = runsRaw ?? [];
    if (runs.length === 0) {
      await finishAgentRun(supabase, run, {
        status: "success",
        output: { vinculados: 0, fila_vazia: true },
      });
      return json({ ok: true, vinculados: 0, fila_vazia: true });
    }

    // 2a. Elo EXATO: input.message_id → messages_inbox.card_id (99% dos
    //     casos; a janela por NF vira só fallback — pego na estreia 23/07,
    //     que casou 6% com janela de tempo por não cobrir anexação a card
    //     antigo). Nota: o select do lote precisa do input.
    const msgIdPorRun = new Map<string, string>();
    for (const r of runs) {
      const mid = messageIdDoInput((r as Record<string, unknown>).input);
      if (mid) msgIdPorRun.set(r.id as string, mid);
    }
    const msgIds = [...new Set(msgIdPorRun.values())];
    const cardPorMsg = new Map<string, string>();
    for (let i = 0; i < msgIds.length; i += CHUNK) {
      const bloco = msgIds.slice(i, i + CHUNK);
      const { data: msgsRaw, error: msgsErr } = await supabase
        .from("messages_inbox")
        .select("id,card_id")
        .in("id", bloco);
      if (msgsErr) throw new Error(`messages_inbox: ${msgsErr.message}`);
      for (const m of msgsRaw ?? []) {
        if (m.card_id) cardPorMsg.set(m.id as string, m.card_id as string);
      }
    }

    // 2b. Fallback por NF+janela só pros runs SEM elo exato
    const nfsPorRun = new Map<string, string[]>();
    const todasNfs = new Set<string>();
    for (const r of runs) {
      const mid = msgIdPorRun.get(r.id as string);
      if (mid && cardPorMsg.has(mid)) continue; // elo exato resolve
      const nfs = nfsDoOutputTriador(r.output);
      nfsPorRun.set(r.id as string, nfs);
      for (const nf of nfs) todasNfs.add(nf);
    }
    const nfsLista = [...todasNfs];
    const candidatosPorNf = new Map<string, CardCandidato[]>();
    for (let i = 0; i < nfsLista.length; i += CHUNK) {
      const bloco = nfsLista.slice(i, i + CHUNK);
      const { data: cardsRaw, error: cardsErr } = await supabase
        .from("cards")
        .select("id,nf,created_at")
        .in("nf", bloco);
      if (cardsErr) throw new Error(`cards: ${cardsErr.message}`);
      for (const c of cardsRaw ?? []) {
        const lista = candidatosPorNf.get(c.nf as string) ?? [];
        lista.push({ id: c.id as string, created_at: c.created_at as string });
        candidatosPorNf.set(c.nf as string, lista);
      }
    }

    // 3. Escolhe e grava (updates em paralelo controlado)
    let vinculados = 0;
    let semMatch = 0;
    const PARALELO = 15;
    for (let i = 0; i < runs.length; i += PARALELO) {
      const bloco = runs.slice(i, i + PARALELO);
      await Promise.all(bloco.map(async (r) => {
        const mid = msgIdPorRun.get(r.id as string);
        const cardId = (mid ? cardPorMsg.get(mid) : undefined) ??
          escolherCardParaRun(
            nfsPorRun.get(r.id as string) ?? [],
            candidatosPorNf,
            r.started_at as string,
          );
        if (!cardId) {
          semMatch += 1;
          return;
        }
        const { error } = await supabase
          .from("agent_runs")
          .update({ card_id: cardId })
          .eq("id", r.id);
        if (error) console.warn(`[vincular-triador] update ${r.id}:`, error.message);
        else vinculados += 1;
      }));
    }

    const resumo = {
      vinculados,
      sem_match: semMatch,
      lidos: runs.length,
      ultimo_started_at: runs[runs.length - 1]?.started_at ?? null,
    };
    await finishAgentRun(supabase, run, { status: "success", output: resumo });
    return json({ ok: true, ...resumo });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishAgentRun(supabase, run, { status: "error", errorMessage: msg });
    return json({ ok: false, error: msg }, 500);
  }
});
