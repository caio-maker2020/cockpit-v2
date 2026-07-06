// =============================================================================
// agente-extravio-d4 — agente autônomo da aba EXTRAVIOS (PART 2).
//
// Caio 2026-06-24: card de extravio (oc 6/9/16) que chega a >= 4 dias úteis sem
// nada lançado depois → lançar a oc 49 ("PRAZO DE PERDAS EXPIRADO"). ANTES de
// lançar, CONFERE no SSW (verdade real-time): se a última oc real ainda é 6/9/16,
// está LIMPO; se já é outra, NÃO RODA — flagga o card pra coluna "AUTÔNOMO NÃO
// RODOU" com a explicação. A pré-checagem SSW acontece em TODO lançamento.
//
// Modos:
//   - "scan" (cron): confere SSW, marca 'recomendado' os limpos / 'nao_rodou' os
//     que já têm oc pós-extravio. NÃO lança (até a flag global do M4).
//   - "execute" {card_ids:[...]}: RE-CONFERE o SSW e lança a 49 só nos card_ids
//     aprovados (validação por lote do Caio, M2). Limpo→lança via envelope; se
//     mudou→nao_rodou. (No M4 o scan autônomo chama o mesmo caminho de execute.)
//
// Gated por feature_flags.extravios_cockpit_enabled + horário comercial BRT.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buscarNFInterno,
  listarOcorrenciasNF,
  obterSessao,
  readSswInternalEnv,
  type SswOcorrencia,
  type SswSessao,
} from "../_shared/ssw-internal-client.ts";
import { isHorarioComercialBRT } from "../_shared/horario-comercial.ts";
import { startAgentRun, finishAgentRun } from "../_shared/agent-runs-logger.ts";
import { montarPropostaLancar49, podeAgenteLancar49 } from "../_shared/agente-extravio-regras.ts";

const FLAG_KEY = "extravios_cockpit_enabled";
const MAX_CARDS = 100;
const TIME_BUDGET_MS = 110_000;
const AGENT_NAME = "agente-extravio-d4";

interface CardElegivel {
  card_id: string;
  nf: string | null;
  ctrc: string | null;
  responsavel_relacionamento: string | null;
  oc_extravio: number | null;
  dias_uteis: number | null;
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
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
  const mode: string = body?.mode === "execute" ? "execute" : "scan";
  const force = body?.force === true;
  const limit = Number.isFinite(body?.limit) ? Math.max(1, Math.min(MAX_CARDS, Number(body.limit))) : MAX_CARDS;

  // Gate: feature flag.
  const { data: flag } = await supabase
    .from("feature_flags").select("enabled").eq("key", FLAG_KEY).maybeSingle();
  if (!(flag as { enabled?: boolean } | null)?.enabled) {
    return json({ ok: true, skipped: "flag_off" }, 200);
  }
  // Gate: horário comercial BRT. force ignora.
  if (!force && !isHorarioComercialBRT(new Date())) {
    return json({ ok: true, skipped: "fora_horario_comercial" }, 200);
  }

  // Flag de autonomia (M4): ON = o scan LANÇA sozinho os limpos; OFF = só recomenda
  // (validação por lote do Caio via execute). A pré-checagem SSW é sempre obrigatória.
  const { data: flagAut } = await supabase
    .from("feature_flags").select("enabled").eq("key", "extravios_agente_autonomo_enabled").maybeSingle();
  const autonomo = (flagAut as { enabled?: boolean } | null)?.enabled === true;

  const sswEnv = readSswInternalEnv(env);
  const sessao = await obterSessao(sswEnv);

  if (mode === "execute") {
    return await runExecute(supabase, sessao, body?.card_ids ?? [], startedAt);
  }
  return await runScan(supabase, sessao, limit, startedAt, autonomo);
});

/** Última oc REAL no SSW (a primeira com código) + a entrada completa. */
async function ultimaOcSsw(
  sessao: SswSessao,
  nf: string,
  ctrc: string | null,
): Promise<{ ocReal: number | null; ultima: SswOcorrencia | null }> {
  const detalhe = await buscarNFInterno(sessao, nf, { ctrcEsperado: ctrc ?? null });
  const ocs = await listarOcorrenciasNF(sessao, detalhe);
  const ultima = ocs.find((o) => o.codigo != null) ?? null;
  return { ocReal: ultima?.codigo ?? null, ultima };
}

/** Marca o card como NÃO RODOU + explica o motivo + card_event. */
async function flagNaoRodou(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  cardId: string,
  ocReal: number,
  ultima: SswOcorrencia | null,
): Promise<string> {
  const desc = ultima?.descricao ? ` (${ultima.descricao})` : "";
  const quando = ultima?.data ? ` lançada em ${ultima.data}` : "";
  const quem = ultima?.usuario ? ` por ${ultima.usuario}` : "";
  const motivo = `Não lancei a oc 49: o SSW já mostra a ocorrência ${ocReal}${desc}${quando}${quem} — depois do extravio. Verifique e reporte.`;
  await supabase.from("cards").update({
    agente_extravio_status: "nao_rodou",
    agente_extravio_motivo: motivo,
    agente_extravio_oc_achada: ocReal,
    agente_extravio_checado_em: new Date().toISOString(),
  }).eq("id", cardId);
  await supabase.from("card_events").insert({
    card_id: cardId, event_type: "AgenteExtravioNaoRodou", actor_type: "agent", actor_id: AGENT_NAME,
    payload: { oc_achada: ocReal, descricao: ultima?.descricao ?? null, data: ultima?.data ?? null, usuario: ultima?.usuario ?? null, motivo },
  });
  return motivo;
}

// ---------------------------------------------------------------------------
// SCAN — confere SSW, marca recomendado (limpo) / nao_rodou (mudou). Não lança.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function runScan(supabase: any, sessao: SswSessao, limit: number, startedAt: number, autonomo: boolean): Promise<Response> {
  const { data: rows, error: selErr } = await supabase
    .from("v_extravios_kanban")
    .select("card_id, nf, ctrc, responsavel_relacionamento, oc_extravio, dias_uteis")
    .eq("coluna_kanban", "D4")
    .is("agente_extravio_status", null)
    .limit(limit);
  if (selErr) return json({ ok: false, error: `SELECT elegíveis: ${selErr.message}` }, 500);

  const elegiveis = (rows ?? []) as CardElegivel[];
  if (elegiveis.length === 0) {
    return json({ ok: true, mode: "scan", elegiveis: 0, nota: "nenhum card D4 pendente", duration_ms: Date.now() - startedAt }, 200);
  }

  const limpos: Array<Record<string, unknown>> = [];
  const lancados: Array<Record<string, unknown>> = [];
  const naoRodou: Array<Record<string, unknown>> = [];
  const erros: string[] = [];

  for (const card of elegiveis) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { erros.push("time budget"); break; }
    const run = startAgentRun({ agentName: AGENT_NAME, stepName: autonomo ? "scan_autonomo" : "scan", cardId: card.card_id, input: { nf: card.nf } });
    try {
      if (!card.nf) { erros.push(`card ${card.card_id} sem NF`); await finishAgentRun(supabase, run, { status: "error", errorMessage: "sem NF" }); continue; }
      const { ocReal, ultima } = await ultimaOcSsw(sessao, card.nf, card.ctrc);
      if (ocReal == null) { erros.push(`NF ${card.nf}: SSW sem oc`); await finishAgentRun(supabase, run, { status: "error", errorMessage: "ssw_sem_oc" }); continue; }

      if (podeAgenteLancar49(ocReal)) {
        if (autonomo) {
          // AUTÔNOMO: SSW confirmou limpo NESTE ciclo → lança a 49 direto.
          const r = await lancar49(supabase, card.card_id, card.nf, ocReal);
          if (!r.ok) { erros.push(r.erro!); await finishAgentRun(supabase, run, { status: "error", errorMessage: r.erro }); continue; }
          lancados.push({ card_id: card.card_id, nf: card.nf, oc_extravio: ocReal, operador: card.responsavel_relacionamento });
          await finishAgentRun(supabase, run, { status: "success", output: { decisao: "lancou_49", todo_id: r.todoId } });
          continue;
        }
        // SOMBRA: só recomenda (Caio valida o lote no execute).
        await supabase.from("cards").update({
          agente_extravio_status: "recomendado", agente_extravio_motivo: null,
          agente_extravio_oc_achada: null, agente_extravio_checado_em: new Date().toISOString(),
        }).eq("id", card.card_id);
        await supabase.from("card_events").insert({
          card_id: card.card_id, event_type: "AgenteExtravioRecomendou", actor_type: "agent", actor_id: AGENT_NAME,
          payload: { oc_real: ocReal, dias_uteis: card.dias_uteis, acao: "lancar_49" },
        });
        limpos.push({ card_id: card.card_id, nf: card.nf, ctrc: card.ctrc, oc_extravio: ocReal, operador: card.responsavel_relacionamento, dias_uteis: card.dias_uteis });
        await finishAgentRun(supabase, run, { status: "success", output: { decisao: "recomendado", oc_real: ocReal } });
        continue;
      }

      const motivo = await flagNaoRodou(supabase, card.card_id, ocReal, ultima);
      naoRodou.push({ card_id: card.card_id, nf: card.nf, oc_achada: ocReal, motivo, operador: card.responsavel_relacionamento });
      await finishAgentRun(supabase, run, { status: "success", output: { decisao: "nao_rodou", oc_achada: ocReal } });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      erros.push(`NF ${card.nf}: ${m}`);
      await finishAgentRun(supabase, run, { status: "error", errorMessage: m });
    }
  }

  return json({ ok: true, mode: "scan", autonomo, elegiveis: elegiveis.length, lancados_count: lancados.length, limpos_count: limpos.length, nao_rodou_count: naoRodou.length, erros_count: erros.length, lancados, limpos, nao_rodou: naoRodou, erros, duration_ms: Date.now() - startedAt }, 200);
}

// ---------------------------------------------------------------------------
// EXECUTE — RE-CONFERE o SSW e lança a 49 nos card_ids aprovados. Pré-checagem
// obrigatória em TODO lançamento: limpo→lança (envelope idempotente); mudou→nao_rodou.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function runExecute(supabase: any, sessao: SswSessao, cardIdsRaw: unknown, startedAt: number): Promise<Response> {
  const cardIds = Array.isArray(cardIdsRaw) ? cardIdsRaw.filter((x) => typeof x === "string") as string[] : [];
  if (cardIds.length === 0) return json({ ok: false, error: "execute exige card_ids: [...]" }, 400);

  const { data: cards } = await supabase
    .from("cards")
    .select("id, nf, ctrc, state, cod_ultima_ocorrencia")
    .in("id", cardIds)
    .eq("state", "EXTRAVIO_MONITORADO");
  const cardById = new Map((cards ?? []).map((c: Record<string, unknown>) => [c.id as string, c]));

  const lancados: Array<Record<string, unknown>> = [];
  const naoRodou: Array<Record<string, unknown>> = [];
  const erros: string[] = [];

  for (const cardId of cardIds) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { erros.push("time budget"); break; }
    const card = cardById.get(cardId) as Record<string, unknown> | undefined;
    const run = startAgentRun({ agentName: AGENT_NAME, stepName: "execute", cardId, input: {} });
    try {
      if (!card) { erros.push(`card ${cardId} não está em EXTRAVIO_MONITORADO`); await finishAgentRun(supabase, run, { status: "error", errorMessage: "card fora do estado" }); continue; }
      const nf = card.nf as string | null;
      if (!nf) { erros.push(`card ${cardId} sem NF`); await finishAgentRun(supabase, run, { status: "error", errorMessage: "sem NF" }); continue; }

      // PRÉ-CHECAGEM SSW OBRIGATÓRIA (de novo, na hora do lançamento).
      const { ocReal, ultima } = await ultimaOcSsw(sessao, nf, (card.ctrc as string | null) ?? null);
      if (ocReal == null) { erros.push(`NF ${nf}: SSW sem oc`); await finishAgentRun(supabase, run, { status: "error", errorMessage: "ssw_sem_oc" }); continue; }

      if (!podeAgenteLancar49(ocReal)) {
        // Mudou desde a recomendação → NÃO lança, flagga.
        const motivo = await flagNaoRodou(supabase, cardId, ocReal, ultima);
        naoRodou.push({ card_id: cardId, nf, oc_achada: ocReal, motivo });
        await finishAgentRun(supabase, run, { status: "success", output: { decisao: "nao_rodou", oc_achada: ocReal } });
        continue;
      }

      // LIMPO → lança a 49 (envelope idempotente + tripé).
      const r = await lancar49(supabase, cardId, nf, ocReal);
      if (!r.ok) { erros.push(r.erro!); await finishAgentRun(supabase, run, { status: "error", errorMessage: r.erro }); continue; }
      lancados.push({ card_id: cardId, nf, oc_extravio: ocReal });
      await finishAgentRun(supabase, run, { status: "success", output: { decisao: "lancou_49", todo_id: r.todoId } });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      erros.push(`card ${cardId}: ${m}`);
      await finishAgentRun(supabase, run, { status: "error", errorMessage: m });
    }
  }

  return json({ ok: true, mode: "execute", pedidos: cardIds.length, lancados_count: lancados.length, nao_rodou_count: naoRodou.length, erros_count: erros.length, lancados, nao_rodou: naoRodou, erros, duration_ms: Date.now() - startedAt }, 200);
}

/** Lança a oc 49 num card JÁ confirmado limpo (caller fez a pré-checagem SSW no
 *  mesmo ciclo). Aprova o todo lancar_49 → executor (envelope) → AGUARDANDO VOCÊ;
 *  cancela as demais propostas de extravio; status='lancou'; evento; snapshot. */
// deno-lint-ignore no-explicit-any
async function lancar49(supabase: any, cardId: string, nf: string, ocReal: number): Promise<{ ok: boolean; erro?: string; todoId?: string }> {
  const { data: todo } = await supabase.from("todos")
    .select("id").eq("card_id", cardId).eq("status", "pendente")
    .eq("proposta_payload->meta->>acao", "lancar_49").maybeSingle();
  let todoId = (todo as { id?: string } | null)?.id;
  // Caio 2026-06-26 (NF 2053248): se não há lancar_49 PENDENTE, RECRIA on-demand.
  // Caso real: o operador escolheu o e-mail antes (email_sem_oc) → a lancar_49 do
  // lote foi auto-cancelada ("outra opção foi aprovada"). O extravio SEGUE contando;
  // no D+4 o agente lança a 49 conforme a regra normal (sem e-mail — cliente já
  // notificado). Antes isso errava "sem todo lancar_49 pendente" e o card travava.
  if (!todoId) {
    const r = await criarPropostaLancar49(supabase, cardId, nf);
    if (!r.ok) return r;
    todoId = r.todoId;
  }

  const { error: rpcErr } = await supabase.rpc("auto_aprovar_e_executar", { p_todo_id: todoId, p_regra: "agente_extravio_d4" });
  if (rpcErr) return { ok: false, erro: `NF ${nf}: auto_aprovar: ${rpcErr.message}` };

  // As demais propostas de extravio (email/54/55) — o agente escolheu a 49.
  await supabase.from("todos").update({
    status: "cancelado",
    rejection_reason: "Agente lançou oc 49 (PRAZO DE PERDAS EXPIRADO) — demais propostas de extravio canceladas",
  }).eq("card_id", cardId).eq("status", "pendente").eq("proposta_payload->meta->>origem", "extravio_cockpit");

  await supabase.from("cards").update({ agente_extravio_status: "lancou", agente_extravio_checado_em: new Date().toISOString() }).eq("id", cardId);
  await supabase.from("card_events").insert({
    card_id: cardId, event_type: "AgenteExtravioLancou49", actor_type: "agent", actor_id: AGENT_NAME,
    payload: { oc_real: ocReal, todo_id: todoId, regra: "agente_extravio_d4" },
  });
  await snapshotAuditoriaExtravio(supabase, cardId, ocReal);
  return { ok: true, todoId };
}

/** Recria a proposta lancar_49 (sem e-mail) quando não há nenhuma pendente —
 *  pega o cnpj_remetente da proposta lancar_49 mais recente (qualquer status) ou
 *  do agent_state. Montador puro = montarPropostaLancar49 (enviar_email:false). */
// deno-lint-ignore no-explicit-any
async function criarPropostaLancar49(supabase: any, cardId: string, nf: string): Promise<{ ok: boolean; erro?: string; todoId?: string }> {
  // cnpj_remetente: prioriza a proposta lancar_49 anterior; fallback agent_state.
  const { data: anterior } = await supabase.from("todos")
    .select("proposta_payload").eq("card_id", cardId)
    .eq("proposta_payload->meta->>acao", "lancar_49")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  let cnpj: string | null =
    ((anterior as { proposta_payload?: { args?: { cnpj_remetente?: string | null } } } | null)
      ?.proposta_payload?.args?.cnpj_remetente) ?? null;
  if (!cnpj) {
    const { data: card } = await supabase.from("cards").select("agent_state").eq("id", cardId).maybeSingle();
    cnpj = ((card as { agent_state?: { cnpj_remetente?: string | null } } | null)?.agent_state?.cnpj_remetente) ?? null;
  }
  const { data: novo, error } = await supabase.from("todos").insert({
    card_id: cardId,
    action_id: crypto.randomUUID(),
    descricao: "Lançar oc 49 (PRAZO DE PERDAS EXPIRADO) — recriada pelo agente D+4",
    status: "pendente",
    proposta_payload: montarPropostaLancar49(nf, cnpj),
  }).select("id").single();
  if (error) return { ok: false, erro: `NF ${nf}: criar proposta lancar_49: ${error.message}` };
  return { ok: true, todoId: (novo as { id: string }).id };
}

/** Snapshot do card na aba AUDITORIA (motivo distinto → filtro "EXTRAVIOS LANÇADOS
 *  AUTÔNOMOS"). Idempotente por (card, motivo). Espelha agente-oc13-autonomo. */
// deno-lint-ignore no-explicit-any
async function snapshotAuditoriaExtravio(supabase: any, cardId: string, ocExtravio: number): Promise<void> {
  const motivo = "extravio_oc49_autonomo";
  const { data: ja } = await supabase.from("cards_auditoria").select("id")
    .eq("card_id_original", cardId).eq("motivo", motivo).maybeSingle();
  if (ja) return;
  const { data: card } = await supabase.from("cards").select("*").eq("id", cardId).maybeSingle();
  if (!card) return;
  const { data: todos } = await supabase.from("todos").select("*").eq("card_id", cardId);
  const { data: events } = await supabase.from("card_events").select("*").eq("card_id", cardId).order("created_at", { ascending: true });
  await supabase.from("cards_auditoria").insert({
    card_id_original: cardId, motivo,
    nf: card.nf, ctrc: card.ctrc, empresa_cliente: card.pagador,
    cod_ultima_ocorrencia: card.cod_ultima_ocorrencia, state_no_snapshot: card.state,
    cnpj_pagador: (card.agent_state as Record<string, unknown> | null)?.["cnpj_pagador"] ?? null,
    card_snapshot: { ...card, _agente: "extravio_d4", _oc_lancada: 49, _oc_extravio: ocExtravio },
    todos_snapshot: todos ?? [], events_snapshot: events ?? [],
  });
  await supabase.from("cards").update({
    em_auditoria: true, auditoria_motivo: motivo, auditoria_added_at: new Date().toISOString(),
  }).eq("id", cardId);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
