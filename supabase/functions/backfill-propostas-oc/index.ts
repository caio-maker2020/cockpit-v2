// =============================================================================
// backfill-propostas-oc — Edge Function (Deno runtime)
//
// Caio 2026-06-18: backfill pontual de propostas auto pra cards que ficaram
// presos em AGUARDANDO_AGENTE ("PARA FAZER") com 0 propostas porque a oc deles
// não tinha regra em REGRAS_AUTO_ACAO na época. Quando uma regra nova é
// adicionada (ex: oc=23 replicando oc=49), o sync-bastao só backfilla os cards
// que o Bastão ainda lista como pendência ATIVA — cards mais antigos, que o
// Bastão não retorna mais, nunca são reprocessados e seguem sem propostas.
//
// Esta função roda a MESMA proporAutoAcaoSeAplicavel direto nos cards alvo,
// então resolve email/template e emite os card_events idênticos ao fluxo normal.
//
// Body (opcional): { codigo_oc?: number, dry_run?: boolean, limit?: number }
//   - codigo_oc: escopa só uma oc (ex: 23). Sem isso, backfilla qualquer oc
//                com regra em REGRAS_AUTO_ACAO.
//   - dry_run:   só conta os candidatos, não cria propostas.
//   - limit:     teto de cards por chamada (default 500).
//
// Idempotente: proporAutoAcaoSeAplicavel não recria proposta já ativa e respeita
// os gates de state/lock. Reexecutar é seguro.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  proporAutoAcaoSeAplicavel,
  REGRAS_AUTO_ACAO,
} from "../_shared/regras-auto-acao.ts";

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    // Cast localizado: o generic do client (<any,"public",any>) não casa com o
    // type SupabaseClient esperado por proporAutoAcaoSeAplicavel; é só tipagem.
    const db = supabase as unknown as Parameters<typeof proporAutoAcaoSeAplicavel>[0];

    let body: { codigo_oc?: number; dry_run?: boolean; limit?: number; card_ids?: string[] } = {};
    try {
      body = await req.json();
    } catch (_) {
      // sem body — backfilla todas as ocs com regra
    }

    const codigoOcFiltro = typeof body.codigo_oc === "number" ? body.codigo_oc : null;
    const dryRun = body.dry_run === true;
    const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : 500;
    // Caio 2026-06-19: destrave cirúrgico de cards presos em AVH+lock com 0
    // propostas (bug transição Extravios→relacionamento oc=20/49). Quando
    // card_ids é passado, busca por id direto — ignora o filtro state/lock
    // padrão (que só pega AGUARDANDO_AGENTE sem lock). proporAutoAcao passa o
    // gate isAdicaoIncremental pra cards em AGUARDANDO_VALIDACAO_HUMANA.
    const cardIdsAlvo = Array.isArray(body.card_ids)
      ? body.card_ids.filter((x) => typeof x === "string" && x.length > 0)
      : null;

    const ocsComRegra = Object.keys(REGRAS_AUTO_ACAO).map((k) => Number(k));

    // Carrega exceções oc=13 (só relevante se backfillar oc=13).
    const excecoesOc13 = new Set<string>();
    const { data: cfg13 } = await supabase
      .from("cliente_config_oc13")
      .select("cnpj_pagador")
      .eq("ativo", true);
    for (const r of (cfg13 ?? []) as Array<{ cnpj_pagador: string }>) {
      if (r.cnpj_pagador) excecoesOc13.add(r.cnpj_pagador);
    }

    // Candidatos: por id explícito (destrave cirúrgico, ignora state/lock) OU
    // o padrão AGUARDANDO_AGENTE sem lock com oc que tem regra.
    let query = supabase
      .from("cards")
      .select("id, nf, ctrc, cod_ultima_ocorrencia, state, lock_aguardando_validacao, agent_state")
      .order("created_at", { ascending: true })
      .limit(limit);

    if (cardIdsAlvo && cardIdsAlvo.length > 0) {
      query = query.in("id", cardIdsAlvo);
    } else {
      query = query
        .eq("state", "AGUARDANDO_AGENTE")
        .eq("lock_aguardando_validacao", false);
      if (codigoOcFiltro != null) {
        query = query.eq("cod_ultima_ocorrencia", codigoOcFiltro);
      } else {
        query = query.in("cod_ultima_ocorrencia", ocsComRegra);
      }
    }

    const { data: cards, error } = await query;
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const candidatos = (cards ?? []) as Array<{
      id: string;
      nf: string | null;
      ctrc: string | null;
      cod_ultima_ocorrencia: number | null;
      state: string;
      lock_aguardando_validacao: boolean;
      agent_state: Record<string, unknown> | null;
    }>;

    if (dryRun) {
      return new Response(
        JSON.stringify({
          ok: true,
          dry_run: true,
          codigo_oc: codigoOcFiltro,
          candidatos: candidatos.length,
          nfs: candidatos.map((c) => c.nf),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    let processados = 0;
    const erros: Array<{ nf: string | null; erro: string }> = [];

    for (const card of candidatos) {
      try {
        await proporAutoAcaoSeAplicavel(db, {
          cardId: card.id,
          cardNf: card.nf,
          cardCtrc: card.ctrc,
          codUltimaOc: card.cod_ultima_ocorrencia,
          agentState: card.agent_state ?? {},
          cardState: card.state,
          cardLock: card.lock_aguardando_validacao,
          actorId: "backfill-propostas-oc",
          excecoesOc13,
        });
        processados++;
      } catch (e) {
        erros.push({
          nf: card.nf,
          erro: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Reconta quantos ainda estão sem propostas (pra medir efeito).
    return new Response(
      JSON.stringify({
        ok: true,
        codigo_oc: codigoOcFiltro,
        candidatos: candidatos.length,
        processados,
        erros,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
