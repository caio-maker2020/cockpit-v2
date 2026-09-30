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
import { montarPropostaLancar49, podeAgenteLancar49, podeAgenteLancar49PosManutencao } from "../_shared/agente-extravio-regras.ts";
import {
  elegivelLancamento49Autonomo,
  MIN_DIA_AUTONOMO_EXTRAVIO,
  resolverDiasAutonomoExtravio,
} from "../_shared/dias-autonomo-extravio.ts";
import {
  decidirReavaliacaoAgente,
  ehCicloNovo,
  ehReincidenciaAchouEPerdeu,
  FLAG_REINCIDENCIA_IMEDIATA,
  motivoFalhasSsw,
  dataBrt,
  type EstadoReavaliacao,
} from "../_shared/agente-extravio-reavaliacao.ts";

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
  cnpj_pagador: string | null;
  assigned_operator_id: string | null;
  /** v_extravios_kanban.data_lancamento = cards.bastao_data_ultima_ocorrencia (data do extravio atual). */
  data_lancamento?: string | null;
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
): Promise<{ ocReal: number | null; ultima: SswOcorrencia | null; anterior: number | null; codigos: number[] }> {
  const detalhe = await buscarNFInterno(sessao, nf, { ctrcEsperado: ctrc ?? null });
  const ocs = await listarOcorrenciasNF(sessao, detalhe);
  const comCodigo = ocs.filter((o) => o.codigo != null);
  const ultima = comCodigo[0] ?? null;
  // v2 oc43 (Caio 28/08): a imediatamente anterior (pulando 43 duplicadas)
  const anterior = comCodigo.slice(1).find((o) => o.codigo !== 43)?.codigo ?? null;
  return { ocReal: ultima?.codigo ?? null, ultima, anterior, codigos: comCodigo.map((o) => o.codigo as number) };
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
  // Duílio 2026-07-28: elegibilidade por LIMIAR configurável (cliente > operador
  // > default 4), não mais coluna_kanban="D4" fixa. Busca do piso (D2) e filtra
  // por card abaixo; ordena mais-dias-primeiro pra priorizar os mais atrasados
  // dentro do budget. O kanban do front (D1..D4 por dias reais) NÃO muda.
  const { data: rows, error: selErr } = await supabase
    .from("v_extravios_kanban")
    .select("card_id, nf, ctrc, cnpj_pagador, assigned_operator_id, responsavel_relacionamento, oc_extravio, dias_uteis, data_lancamento")
    .gte("dias_uteis", MIN_DIA_AUTONOMO_EXTRAVIO)
    .is("agente_extravio_status", null)
    .order("dias_uteis", { ascending: false })
    .limit(limit);
  if (selErr) return json({ ok: false, error: `SELECT elegíveis: ${selErr.message}` }, 500);

  const candidatos = (rows ?? []) as CardElegivel[];
  // Prefetch dos limiares em lote: operador (por id) + cliente (por cnpj).
  const opIds = [...new Set(candidatos.map((c) => c.assigned_operator_id).filter(Boolean))] as string[];
  const cnpjs = [...new Set(candidatos.map((c) => c.cnpj_pagador).filter(Boolean))] as string[];
  const diasPorOperador = new Map<string, number | null>();
  const diasPorCliente = new Map<string, number | null>();
  if (opIds.length) {
    const { data: ops } = await supabase.from("operadores").select("id, dias_autonomo_extravio").in("id", opIds);
    for (const o of (ops ?? []) as Array<{ id: string; dias_autonomo_extravio: number | null }>) diasPorOperador.set(o.id, o.dias_autonomo_extravio);
  }
  if (cnpjs.length) {
    const { data: cfg } = await supabase.from("cliente_config").select("cnpj_pagador, dias_autonomo_extravio").in("cnpj_pagador", cnpjs);
    for (const c of (cfg ?? []) as Array<{ cnpj_pagador: string; dias_autonomo_extravio: number | null }>) diasPorCliente.set(c.cnpj_pagador, c.dias_autonomo_extravio);
  }
  // Resolve o limiar por card e descarta quem ainda não atingiu.
  const elegiveis = candidatos.filter((card) => {
    const limiar = resolverDiasAutonomoExtravio(
      card.assigned_operator_id ? diasPorOperador.get(card.assigned_operator_id) ?? null : null,
      card.cnpj_pagador ? diasPorCliente.get(card.cnpj_pagador) ?? null : null,
    );
    return elegivelLancamento49Autonomo(card.dias_uteis, limiar);
  });
  // (Carlos 30/09) Sem elegível no limiar a rodada NÃO termina mais aqui: as
  // etapas de reavaliação e de reincidência rodam depois do laço principal.
  const notaSemElegivel = elegiveis.length === 0 ? "nenhum card elegível pelo limiar (operador/cliente)" : undefined;

  const limpos: Array<Record<string, unknown>> = [];
  const lancados: Array<Record<string, unknown>> = [];
  const naoRodou: Array<Record<string, unknown>> = [];
  const erros: string[] = [];

  for (const card of elegiveis) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { erros.push("time budget"); break; }
    const run = startAgentRun({ agentName: AGENT_NAME, stepName: autonomo ? "scan_autonomo" : "scan", cardId: card.card_id, input: { nf: card.nf } });
    try {
      if (!card.nf) { erros.push(`card ${card.card_id} sem NF`); await finishAgentRun(supabase, run, { status: "error", errorMessage: "sem NF" }); continue; }
      const { ocReal, ultima, anterior } = await ultimaOcSsw(sessao, card.nf, card.ctrc);
      if (ocReal == null) { erros.push(`NF ${card.nf}: SSW sem oc`); await finishAgentRun(supabase, run, { status: "error", errorMessage: "ssw_sem_oc" }); continue; }

      if (podeAgenteLancar49PosManutencao(ocReal, anterior)) {
        if (autonomo) {
          // AUTÔNOMO: SSW confirmou limpo NESTE ciclo → lança a 49 direto.
          const r = await lancar49(supabase, card.card_id, card.nf, ocReal, { dataExtravio: card.data_lancamento ?? null });
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

  // Etapas novas (Carlos 30/09, INV-163) — DEPOIS do laço principal, com o
  // tempo que sobrar. Não mudam nada pra card sem marcação.
  const reavaliacao = await etapaSegura("reavaliacao", () => runReavaliacaoMarcados(supabase, sessao, startedAt, autonomo, limit));
  // SSW ocupado nesta hora (rodada principal leu/lançou) → a observação espera a
  // próxima: o 429 da NF 14877 nasceu justamente numa rodada cheia (21/09 08h).
  const sswOcupado = elegiveis.length > 0 || ((reavaliacao["lancados"] as unknown[] | undefined)?.length ?? 0) > 0;
  const reincidencia = await etapaSegura("reincidencia", () => runReincidenciaImediata(supabase, sessao, startedAt, autonomo, sswOcupado));

  return json({ ok: true, mode: "scan", autonomo, elegiveis: elegiveis.length, nota: notaSemElegivel, lancados_count: lancados.length, limpos_count: limpos.length, nao_rodou_count: naoRodou.length, erros_count: erros.length, lancados, limpos, nao_rodou: naoRodou, erros, reavaliacao, reincidencia, duration_ms: Date.now() - startedAt }, 200);
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
    .select("id, nf, ctrc, state, cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia")
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
      const { ocReal, ultima, anterior: anterior2 } = await ultimaOcSsw(sessao, nf, (card.ctrc as string | null) ?? null);
      if (ocReal == null) { erros.push(`NF ${nf}: SSW sem oc`); await finishAgentRun(supabase, run, { status: "error", errorMessage: "ssw_sem_oc" }); continue; }

      if (!podeAgenteLancar49PosManutencao(ocReal, anterior2)) {
        // Mudou desde a recomendação → NÃO lança, flagga.
        const motivo = await flagNaoRodou(supabase, cardId, ocReal, ultima);
        naoRodou.push({ card_id: cardId, nf, oc_achada: ocReal, motivo });
        await finishAgentRun(supabase, run, { status: "success", output: { decisao: "nao_rodou", oc_achada: ocReal } });
        continue;
      }

      // LIMPO → lança a 49 (envelope idempotente + tripé).
      const r = await lancar49(supabase, cardId, nf, ocReal, { dataExtravio: (card.bastao_data_ultima_ocorrencia as string | null) ?? null });
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
async function lancar49(supabase: any, cardId: string, nf: string, ocReal: number, extra: { dataExtravio: string | null; reavaliacao?: string } = { dataExtravio: null }): Promise<{ ok: boolean; erro?: string; todoId?: string }> {
  // Carlos 30/09: a data do extravio TRATADO vai no evento — é ela que separa
  // o mesmo ciclo de um ciclo novo (ehCicloNovo), sem depender de relógio.
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
    payload: {
      oc_real: ocReal, todo_id: todoId, regra: "agente_extravio_d4",
      data_extravio: extra.dataExtravio,
      ...(extra.reavaliacao ? { reavaliacao: extra.reavaliacao } : {}),
    },
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

// ---------------------------------------------------------------------------
// REAVALIAÇÃO DOS MARCADOS (Carlos 30/09, INV-163). Cards ainda na aba
// Extravios com a marcação 'lancou': (1) a 49 do agente falhou no SSW → tenta
// de novo, até MAX_TENTATIVAS_49_POR_CICLO, e depois manda pra operadora (NÃO
// RODOU); (2) teve um NOVO extravio depois do ciclo tratado → volta a contar o
// limiar. Decisão pura em _shared/agente-extravio-reavaliacao.ts. Toda 49 daqui
// passa pela MESMA pré-checagem SSW e pelo MESMO lancar49 (envelope) da rodada
// principal. Âncoras: NF 14877 (falha 429 em 21/09), NF 787209 (novo extravio).
// ---------------------------------------------------------------------------
type CardMarcado = CardElegivel & { agente_extravio_checado_em: string | null };

async function runReavaliacaoMarcados(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  sessao: SswSessao,
  startedAt: number,
  autonomo: boolean,
  limit: number,
): Promise<Record<string, unknown>> {
  const res = {
    avaliados: 0,
    aguardando_limiar: 0,
    lancados: [] as Array<Record<string, unknown>>,
    nao_rodou: [] as Array<Record<string, unknown>>,
    erros: [] as string[],
  };
  // 'lancou' só nasce no modo autônomo; sem ele o agente não relança nada.
  if (!autonomo) return res;
  if (Date.now() - startedAt > TIME_BUDGET_MS) { res.erros.push("time budget"); return res; }

  const { data: rows, error } = await supabase
    .from("v_extravios_kanban")
    .select("card_id, nf, ctrc, cnpj_pagador, assigned_operator_id, responsavel_relacionamento, oc_extravio, dias_uteis, data_lancamento, agente_extravio_checado_em")
    .eq("agente_extravio_status", "lancou")
    .order("dias_uteis", { ascending: false })
    .limit(limit);
  if (error) { res.erros.push(`SELECT marcados: ${error.message}`); return res; }
  const marcados = (rows ?? []) as CardMarcado[];
  if (marcados.length === 0) return res;
  const limiares = await carregarLimiares(supabase, marcados);

  for (const card of marcados) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { res.erros.push("time budget"); break; }
    res.avaliados++;
    const { estado, ultimoErro } = await carregarEstadoReavaliacao(supabase, card);
    const decisao = decidirReavaliacaoAgente(estado);
    if (decisao.tipo === "ignorar") continue;

    const run = startAgentRun({ agentName: AGENT_NAME, stepName: `reavaliacao_${decisao.tipo}`, cardId: card.card_id, input: { nf: card.nf, decisao } });
    try {
      if (decisao.tipo === "avisar_operadora") {
        const motivo = await flagFalhasSsw(supabase, card.card_id, decisao.tentativas, ultimoErro);
        res.nao_rodou.push({ card_id: card.card_id, nf: card.nf, motivo });
        await finishAgentRun(supabase, run, { status: "success", output: { decisao: "avisar_operadora", tentativas: decisao.tentativas } });
        continue;
      }
      if (decisao.tipo === "avaliar_normal") {
        // Ciclo novo: mesma régua de sempre (cliente > operador > 4 dias úteis).
        const limiar = limiarDoCard(limiares, card);
        if (!elegivelLancamento49Autonomo(card.dias_uteis, limiar)) {
          res.aguardando_limiar++;
          await finishAgentRun(supabase, run, { status: "success", output: { decisao: "aguardando_limiar", dias_uteis: card.dias_uteis, limiar } });
          continue;
        }
      }
      if (!card.nf) { res.erros.push(`card ${card.card_id} sem NF`); await finishAgentRun(supabase, run, { status: "error", errorMessage: "sem NF" }); continue; }

      // PRÉ-CHECAGEM SSW OBRIGATÓRIA (a mesma da rodada principal).
      const { ocReal, ultima, anterior } = await ultimaOcSsw(sessao, card.nf, card.ctrc);
      if (ocReal == null) { res.erros.push(`NF ${card.nf}: SSW sem oc`); await finishAgentRun(supabase, run, { status: "error", errorMessage: "ssw_sem_oc" }); continue; }
      if (!podeAgenteLancar49PosManutencao(ocReal, anterior)) {
        const motivo = await flagNaoRodou(supabase, card.card_id, ocReal, ultima);
        res.nao_rodou.push({ card_id: card.card_id, nf: card.nf, oc_achada: ocReal, motivo });
        await finishAgentRun(supabase, run, { status: "success", output: { decisao: "nao_rodou", oc_achada: ocReal } });
        continue;
      }
      const reavaliacao = decisao.tipo === "tentar_de_novo" ? `nova_tentativa_${decisao.tentativa}` : "ciclo_novo";
      const r = await lancar49(supabase, card.card_id, card.nf, ocReal, { dataExtravio: card.data_lancamento ?? null, reavaliacao });
      if (!r.ok) { res.erros.push(r.erro!); await finishAgentRun(supabase, run, { status: "error", errorMessage: r.erro }); continue; }
      res.lancados.push({ card_id: card.card_id, nf: card.nf, reavaliacao });
      await finishAgentRun(supabase, run, { status: "success", output: { decisao: "lancou_49", reavaliacao, todo_id: r.todoId } });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      res.erros.push(`NF ${card.nf}: ${m}`);
      await finishAgentRun(supabase, run, { status: "error", errorMessage: m });
    }
  }
  return res;
}

/** Monta o estado da decisão a partir de eventos append-only e das ações no SSW. */
async function carregarEstadoReavaliacao(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  card: CardMarcado,
): Promise<{ estado: EstadoReavaliacao; ultimoErro: string | null }> {
  const { data: evs } = await supabase
    .from("card_events")
    .select("created_at, payload")
    .eq("card_id", card.card_id)
    .eq("event_type", "AgenteExtravioLancou49")
    .order("created_at", { ascending: false })
    .limit(20);
  const lancamentos = (evs ?? []) as Array<{ created_at: string; payload: Record<string, unknown> | null }>;
  const ultimo = lancamentos[0] ?? null;
  const dataExtravio = card.data_lancamento ?? null;
  const tentativasNoCiclo = dataExtravio
    ? lancamentos.filter((e) => (dataBrt(e.created_at) ?? "") >= dataExtravio).length
    : 0;

  let teve49ComSucessoDepois = false;
  if (card.agente_extravio_checado_em) {
    const desde = new Date(Date.parse(card.agente_extravio_checado_em) - 5 * 60_000).toISOString();
    const { data: ok } = await supabase
      .from("acoes_executadas_ssw")
      .select("id")
      .eq("card_id", card.card_id)
      .eq("codigo_oc", 49)
      .eq("sucesso", true)
      .gte("iniciado_em", desde)
      .limit(1);
    teve49ComSucessoDepois = ((ok ?? []) as unknown[]).length > 0;
  }

  // A falha tem de ser do todo da ÚLTIMA 49 do agente (não de outra ação do card).
  let ultimaTentativaFalhou = false;
  let ultimoErro: string | null = null;
  const todoId = (ultimo?.payload?.["todo_id"] as string | undefined) ?? null;
  if (ultimo && todoId) {
    const { data: falhas } = await supabase
      .from("card_events")
      .select("payload")
      .eq("card_id", card.card_id)
      .eq("event_type", "AcaoRevertidaPosFalha")
      .eq("payload->>todo_id", todoId)
      .gte("created_at", ultimo.created_at)
      .order("created_at", { ascending: false })
      .limit(1);
    const f = ((falhas ?? []) as Array<{ payload: Record<string, unknown> | null }>)[0];
    if (f) {
      ultimaTentativaFalhou = true;
      ultimoErro = (f.payload?.["motivo"] as string | undefined) ?? null;
    }
  }

  return {
    estado: {
      status: "lancou",
      checadoEm: card.agente_extravio_checado_em,
      dataExtravio,
      dataExtravioTratado: (ultimo?.payload?.["data_extravio"] as string | undefined) ?? null,
      teve49ComSucessoDepois,
      ultimaTentativaFalhou,
      tentativasNoCiclo,
    },
    ultimoErro,
  };
}

/** O SSW recusou a 49 todas as vezes → NÃO RODOU com o motivo, pra operadora ver. */
async function flagFalhasSsw(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  cardId: string,
  tentativas: number,
  ultimoErro: string | null,
): Promise<string> {
  const motivo = motivoFalhasSsw(tentativas, ultimoErro);
  await supabase.from("cards").update({
    agente_extravio_status: "nao_rodou",
    agente_extravio_motivo: motivo,
    agente_extravio_oc_achada: null,
    agente_extravio_checado_em: new Date().toISOString(),
  }).eq("id", cardId);
  await supabase.from("card_events").insert({
    card_id: cardId, event_type: "AgenteExtravioNaoRodou", actor_type: "agent", actor_id: AGENT_NAME,
    payload: { motivo, causa: "falhas_ssw", tentativas, ultimo_erro: ultimoErro },
  });
  return motivo;
}

// ---------------------------------------------------------------------------
// REINCIDÊNCIA "ACHOU E PERDEU DE NOVO" (Carlos 29/09): extravio → 20 (extravio
// localizado) → extravio recebe a 49 no MESMO dia, sem esperar o limiar.
// Nasce em OBSERVAÇÃO: com a flag extravios_reincidencia_imediata_enabled OFF
// (ou ausente) o agente só ANOTA em agent_runs (step 'reincidencia') quem
// receberia — não toca no card, não lança, não grava card_event. Ligada, usa o
// MESMO lancar49 da rodada principal. Só lê o SSW de quem tem sinal de extravio
// anterior no Cockpit, no máximo MAX_LEITURAS_REINCIDENCIA por rodada e uma vez
// por (card, data do extravio).
// ---------------------------------------------------------------------------
const MAX_LEITURAS_REINCIDENCIA = 15;

type CardJovem = CardElegivel & { agente_extravio_status: string | null; agente_extravio_checado_em: string | null };

async function runReincidenciaImediata(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  sessao: SswSessao,
  startedAt: number,
  autonomo: boolean,
  sswOcupado: boolean,
): Promise<Record<string, unknown>> {
  const { data: flag } = await supabase
    .from("feature_flags").select("enabled").eq("key", FLAG_REINCIDENCIA_IMEDIATA).maybeSingle();
  const ligado = autonomo && (flag as { enabled?: boolean } | null)?.enabled === true;
  const res = {
    modo: ligado ? "ligado" : "observacao",
    candidatos: 0,
    lidos: 0,
    reincidentes: [] as Array<Record<string, unknown>>,
    lancados: [] as Array<Record<string, unknown>>,
    erros: [] as string[],
  };
  if (sswOcupado) return { ...res, adiada: "rodada principal usou o SSW nesta hora" };
  if (Date.now() - startedAt > TIME_BUDGET_MS) { res.erros.push("time budget"); return res; }

  const { data: rows, error } = await supabase
    .from("v_extravios_kanban")
    .select("card_id, nf, ctrc, cnpj_pagador, assigned_operator_id, responsavel_relacionamento, oc_extravio, dias_uteis, data_lancamento, agente_extravio_status, agente_extravio_checado_em")
    .or("agente_extravio_status.is.null,agente_extravio_status.eq.lancou")
    .order("dias_uteis", { ascending: true })
    .limit(500);
  if (error) { res.erros.push(`SELECT jovens: ${error.message}`); return res; }
  const todos = (rows ?? []) as CardJovem[];
  if (todos.length === 0) return res;
  const limiares = await carregarLimiares(supabase, todos);

  // Só quem AINDA NÃO chegou no limiar — quem chegou é da rodada principal.
  const abaixo: CardJovem[] = [];
  for (const c of todos) {
    if (!c.nf || !c.data_lancamento) continue;
    if (elegivelLancamento49Autonomo(c.dias_uteis, limiarDoCard(limiares, c))) continue;
    if (c.agente_extravio_status === "lancou") {
      // Marcado: só entra se o extravio atual for OUTRO (ciclo novo).
      const { data: ev } = await supabase
        .from("card_events").select("payload")
        .eq("card_id", c.card_id).eq("event_type", "AgenteExtravioLancou49")
        .order("created_at", { ascending: false }).limit(1);
      const tratado = (((ev ?? []) as Array<{ payload: Record<string, unknown> | null }>)[0]?.payload?.["data_extravio"] as string | undefined) ?? null;
      if (!ehCicloNovo({ checadoEm: c.agente_extravio_checado_em, dataExtravio: c.data_lancamento, dataExtravioTratado: tratado })) continue;
    }
    abaixo.push(c);
  }
  if (abaixo.length === 0) return res;

  const comSinal = await cardsComSinalDeExtravioAnterior(supabase, abaixo);
  const jaAvaliados = await reincidenciasJaAvaliadas(supabase, abaixo.map((c) => c.card_id));
  const candidatos = abaixo.filter((c) => comSinal.has(c.card_id) && !jaAvaliados.has(`${c.card_id}|${c.data_lancamento}`));
  res.candidatos = candidatos.length;

  for (const card of candidatos) {
    if (res.lidos >= MAX_LEITURAS_REINCIDENCIA) break;
    if (Date.now() - startedAt > TIME_BUDGET_MS) { res.erros.push("time budget"); break; }
    res.lidos++;
    const run = startAgentRun({ agentName: AGENT_NAME, stepName: "reincidencia", cardId: card.card_id, input: { nf: card.nf, data_extravio: card.data_lancamento } });
    try {
      const { ocReal, anterior, codigos } = await ultimaOcSsw(sessao, card.nf!, card.ctrc);
      if (ocReal == null) { res.erros.push(`NF ${card.nf}: SSW sem oc`); await finishAgentRun(supabase, run, { status: "error", errorMessage: "ssw_sem_oc" }); continue; }
      // Pré-checagem de sempre (extravio é a última oc) + o padrão achou-e-perdeu.
      const reincidente = podeAgenteLancar49PosManutencao(ocReal, anterior) && ehReincidenciaAchouEPerdeu(codigos);
      let lancou = false;
      if (reincidente) {
        res.reincidentes.push({ card_id: card.card_id, nf: card.nf, dias_uteis: card.dias_uteis, data_extravio: card.data_lancamento });
        if (ligado) {
          const r = await lancar49(supabase, card.card_id, card.nf!, ocReal, { dataExtravio: card.data_lancamento ?? null, reavaliacao: "reincidencia_imediata" });
          if (r.ok) { lancou = true; res.lancados.push({ card_id: card.card_id, nf: card.nf }); }
          else res.erros.push(r.erro!);
        }
      }
      await finishAgentRun(supabase, run, {
        status: "success",
        output: { data_extravio: card.data_lancamento, reincidente, modo: res.modo, lancou, oc_real: ocReal, dias_uteis: card.dias_uteis },
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      res.erros.push(`NF ${card.nf}: ${m}`);
      await finishAgentRun(supabase, run, { status: "error", errorMessage: m });
    }
  }
  return res;
}

/**
 * Sinal BARATO (sem SSW) de que o CT-e já teve extravio antes do atual: (a)
 * proposta de extravio criada ANTES do dia do extravio atual; (b) 49 já lançada
 * no card; (c) outro card do mesmo CTRC que entrou como extravio. Só decide se
 * vale LER o SSW — quem decide a reincidência é o histórico do SSW.
 */
async function cardsComSinalDeExtravioAnterior(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  cards: CardJovem[],
): Promise<Set<string>> {
  const ids = cards.map((c) => c.card_id);
  const dataPorCard = new Map(cards.map((c) => [c.card_id, c.data_lancamento ?? ""]));
  const out = new Set<string>();

  const props = await emLotes(ids, (lote) =>
    supabase.from("todos").select("card_id, created_at")
      .in("card_id", lote)
      .eq("proposta_payload->meta->>origem", "extravio_cockpit"));
  for (const p of props as Array<{ card_id: string; created_at: string }>) {
    const dia = dataBrt(p.created_at);
    if (dia && dia < (dataPorCard.get(p.card_id) ?? "")) out.add(p.card_id);
  }

  const oks = await emLotes(ids, (lote) =>
    supabase.from("acoes_executadas_ssw").select("card_id")
      .in("card_id", lote).eq("codigo_oc", 49).eq("sucesso", true));
  for (const o of oks as Array<{ card_id: string }>) out.add(o.card_id);

  const ctrcs = [...new Set(cards.map((c) => c.ctrc).filter(Boolean))] as string[];
  if (ctrcs.length) {
    const irmaos = await emLotes(ctrcs, (lote) => supabase.from("cards").select("id, ctrc").in("ctrc", lote));
    const outros = (irmaos as Array<{ id: string; ctrc: string }>).filter((i) => !ids.includes(i.id));
    if (outros.length) {
      const evs = await emLotes(outros.map((o) => o.id), (lote) =>
        supabase.from("card_events").select("card_id")
          .in("card_id", lote).eq("event_type", "ExtravioImportado"));
      const ctrcComExtravio = new Set(
        (evs as Array<{ card_id: string }>).map((e) => outros.find((o) => o.id === e.card_id)?.ctrc).filter(Boolean),
      );
      for (const c of cards) if (c.ctrc && ctrcComExtravio.has(c.ctrc)) out.add(c.card_id);
    }
  }
  return out;
}

/** (card|data do extravio) já avaliados com sucesso — não lê o SSW de novo. */
async function reincidenciasJaAvaliadas(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  ids: string[],
): Promise<Set<string>> {
  const data = await emLotes(ids, (lote) =>
    supabase.from("agent_runs").select("card_id, output")
      .eq("agent_name", AGENT_NAME).eq("step_name", "reincidencia").eq("status", "success")
      .in("card_id", lote));
  return new Set(
    (data as Array<{ card_id: string; output: Record<string, unknown> | null }>)
      .map((r) => `${r.card_id}|${(r.output?.["data_extravio"] as string | undefined) ?? ""}`),
  );
}

/** Limiares em lote (operador por id, cliente por CNPJ) — a mesma régua do scan. */
async function carregarLimiares(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  cards: CardElegivel[],
): Promise<{ porOperador: Map<string, number | null>; porCliente: Map<string, number | null> }> {
  const porOperador = new Map<string, number | null>();
  const porCliente = new Map<string, number | null>();
  const opIds = [...new Set(cards.map((c) => c.assigned_operator_id).filter(Boolean))] as string[];
  const cnpjs = [...new Set(cards.map((c) => c.cnpj_pagador).filter(Boolean))] as string[];
  if (opIds.length) {
    const { data: ops } = await supabase.from("operadores").select("id, dias_autonomo_extravio").in("id", opIds);
    for (const o of (ops ?? []) as Array<{ id: string; dias_autonomo_extravio: number | null }>) porOperador.set(o.id, o.dias_autonomo_extravio);
  }
  if (cnpjs.length) {
    const { data: cfg } = await supabase.from("cliente_config").select("cnpj_pagador, dias_autonomo_extravio").in("cnpj_pagador", cnpjs);
    for (const c of (cfg ?? []) as Array<{ cnpj_pagador: string; dias_autonomo_extravio: number | null }>) porCliente.set(c.cnpj_pagador, c.dias_autonomo_extravio);
  }
  return { porOperador, porCliente };
}

function limiarDoCard(
  l: { porOperador: Map<string, number | null>; porCliente: Map<string, number | null> },
  card: CardElegivel,
): number {
  return resolverDiasAutonomoExtravio(
    card.assigned_operator_id ? l.porOperador.get(card.assigned_operator_id) ?? null : null,
    card.cnpj_pagador ? l.porCliente.get(card.cnpj_pagador) ?? null : null,
  );
}

/**
 * `.in(...)` em lotes: lista grande de ids num GET estoura o tamanho da URL do
 * PostgREST e a consulta falha calada. Erro de qualquer lote → lança (a rodada
 * registra o erro em vez de seguir com dado incompleto).
 */
async function emLotes<T>(
  valores: string[],
  consulta: (lote: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  tamanho = 80,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < valores.length; i += tamanho) {
    const { data, error } = await consulta(valores.slice(i, i + tamanho));
    if (error) throw new Error(`consulta em lote: ${error.message}`);
    out.push(...(data ?? []));
  }
  return out;
}

/** Etapa nova nunca derruba a rodada principal: erro vira campo da resposta. */
async function etapaSegura(nome: string, fn: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return await fn();
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error(`[${AGENT_NAME}] etapa ${nome} falhou:`, m);
    return { erro: m };
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
