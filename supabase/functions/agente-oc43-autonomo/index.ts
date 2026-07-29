// =============================================================================
// agente-oc43-autonomo — automatiza cards em oc 43 ("manutenção perecível
// realizada" — Relacionamento). Duílio 2026-07-29 (INV-061).
//
// Regra: consulta o SSW ao vivo, acha a oc IMEDIATAMENTE ANTERIOR à 43:
//   - anterior ∈ {3,6,8,9,10,11,13,16,17,18,19,20,23,31,35} → lança oc 49
//   - qualquer outra anterior → lança oc 55
//   - sem oc anterior / SSW já saiu de 43 → NÃO age (deixa AVH manual)
//
// Modos (uma flag decide, não há execute-por-lote — o Caio valida no shadow e
// depois liga a autonomia):
//   - SHADOW (oc43_agente_autonomo_enabled=false): confere SSW e marca
//     'recomendado' + card_event, SEM lançar. Caio confere o lote real.
//   - AUTÔNOMO (=true): confere SSW e LANÇA (49/55) via envelope
//     lancarSswPortal (tripé + idempotência). Reprocessa também os que ficaram
//     'recomendado' no shadow.
//
// Gated por feature_flags.oc43_cockpit_enabled + horário comercial BRT.
// Lançamento SEMPRE via auto_aprovar_e_executar → executor → envelope (mesmo
// caminho de agente-oc13-autonomo / agente-extravio-d4). Não inventa caminho.
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
import { finishAgentRun, startAgentRun } from "../_shared/agent-runs-logger.ts";
import {
  decidirOc43DoHistorico,
  montarPropostaOc43,
  OC_ALVO_43,
} from "../_shared/oc43-regras.ts";

const FLAG_KEY = "oc43_cockpit_enabled";
const AUTONOMO_FLAG = "oc43_agente_autonomo_enabled";
const AGENT_NAME = "agente-oc43-autonomo";
const MAX_CARDS = 100;
const TIME_BUDGET_MS = 110_000;

interface CardOc43 {
  id: string;
  nf: string | null;
  ctrc: string | null;
  agent_state: Record<string, unknown> | null;
  agente_oc43_status: string | null;
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
  const force = body?.force === true;
  const limit = Number.isFinite(body?.limit)
    ? Math.max(1, Math.min(MAX_CARDS, Number(body.limit)))
    : MAX_CARDS;

  // Gate: master flag.
  const { data: flag } = await supabase
    .from("feature_flags").select("enabled").eq("key", FLAG_KEY).maybeSingle();
  if (!(flag as { enabled?: boolean } | null)?.enabled) {
    return json({ ok: true, skipped: "flag_off" }, 200);
  }
  // Gate: horário comercial BRT (force ignora).
  if (!force && !isHorarioComercialBRT(new Date())) {
    return json({ ok: true, skipped: "fora_horario_comercial" }, 200);
  }

  // Autonomia: ON lança no SSW; OFF só recomenda (shadow).
  const { data: flagAut } = await supabase
    .from("feature_flags").select("enabled").eq("key", AUTONOMO_FLAG).maybeSingle();
  const autonomo = (flagAut as { enabled?: boolean } | null)?.enabled === true;

  // Cards em AVH + oc 43 ainda não processados. No autônomo, reprocessa também os
  // que ficaram 'recomendado' no shadow (senão o flip da flag nunca os lançaria).
  let query = supabase
    .from("cards")
    .select("id, nf, ctrc, agent_state, agente_oc43_status")
    .eq("cod_ultima_ocorrencia", OC_ALVO_43)
    .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
    .limit(limit);
  query = autonomo
    ? query.or("agente_oc43_status.is.null,agente_oc43_status.eq.recomendado")
    : query.is("agente_oc43_status", null);
  const { data: rows, error: selErr } = await query;
  if (selErr) return json({ ok: false, error: `SELECT oc43: ${selErr.message}` }, 500);

  const cards = (rows ?? []) as CardOc43[];
  if (cards.length === 0) {
    return json({ ok: true, autonomo, elegiveis: 0, duration_ms: Date.now() - startedAt }, 200);
  }

  const sswEnv = readSswInternalEnv(env);
  const sessao = await obterSessao(sswEnv);

  const recomendados: Array<Record<string, unknown>> = [];
  const lancados: Array<Record<string, unknown>> = [];
  const semAcao: Array<Record<string, unknown>> = [];
  const erros: string[] = [];

  for (const card of cards) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { erros.push("time budget"); break; }
    const run = startAgentRun({
      agentName: AGENT_NAME,
      stepName: autonomo ? "autonomo" : "shadow",
      cardId: card.id,
      input: { nf: card.nf },
    });
    try {
      if (!card.nf) {
        erros.push(`card ${card.id} sem NF`);
        await finishAgentRun(supabase, run, { status: "error", errorMessage: "sem NF" });
        continue;
      }
      // Consulta o histórico completo do SSW ao vivo (a oc anterior NÃO está no card).
      const ocs = await consultarHistoricoSsw(sessao, card.nf, card.ctrc);
      const decisao = decidirOc43DoHistorico(ocs);

      if (decisao.acao === "sem_acao") {
        await marcarSemAcao(supabase, card.id, decisao.motivo, decisao.ocRealSsw);
        semAcao.push({ card_id: card.id, nf: card.nf, motivo: decisao.motivo, oc_real: decisao.ocRealSsw });
        await finishAgentRun(supabase, run, { status: "success", output: { decisao: "sem_acao", motivo: decisao.motivo } });
        continue;
      }

      const codigoSsw = decisao.acao === "lancar_49" ? 49 : 55;

      if (!autonomo) {
        // SHADOW: só recomenda.
        await supabase.from("cards").update({
          agente_oc43_status: "recomendado",
          agente_oc43_motivo: null,
          agente_oc43_oc_anterior: decisao.ocAnterior,
          agente_oc43_checado_em: new Date().toISOString(),
        }).eq("id", card.id);
        await supabase.from("card_events").insert({
          card_id: card.id, event_type: "AgenteOc43Recomendou", actor_type: "agent", actor_id: AGENT_NAME,
          payload: { acao: decisao.acao, oc_anterior: decisao.ocAnterior, oc_anterior_desc: decisao.ocAnteriorDesc, codigo_ssw: codigoSsw },
        });
        recomendados.push({ card_id: card.id, nf: card.nf, acao: decisao.acao, oc_anterior: decisao.ocAnterior });
        await finishAgentRun(supabase, run, { status: "success", output: { decisao: "recomendado", acao: decisao.acao } });
        continue;
      }

      // AUTÔNOMO: lança via envelope.
      const r = await lancarOc43(supabase, card, codigoSsw, decisao.ocAnterior, decisao.ocAnteriorDesc);
      if (!r.ok) {
        await marcarErro(supabase, card.id, r.erro!);
        erros.push(r.erro!);
        await finishAgentRun(supabase, run, { status: "error", errorMessage: r.erro });
        continue;
      }
      lancados.push({ card_id: card.id, nf: card.nf, acao: decisao.acao, oc_anterior: decisao.ocAnterior, todo_id: r.todoId });
      await finishAgentRun(supabase, run, { status: "success", output: { decisao: decisao.acao, todo_id: r.todoId } });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      erros.push(`NF ${card.nf}: ${m}`);
      await finishAgentRun(supabase, run, { status: "error", errorMessage: m });
    }
  }

  return json({
    ok: true, autonomo, elegiveis: cards.length,
    recomendados_count: recomendados.length, lancados_count: lancados.length,
    sem_acao_count: semAcao.length, erros_count: erros.length,
    recomendados, lancados, sem_acao: semAcao, erros,
    duration_ms: Date.now() - startedAt,
  }, 200);
});

/** Histórico completo do SSW (most-recent-first) pra achar a oc anterior à 43. */
async function consultarHistoricoSsw(
  sessao: SswSessao,
  nf: string,
  ctrc: string | null,
): Promise<SswOcorrencia[]> {
  const detalhe = await buscarNFInterno(sessao, nf, { ctrcEsperado: ctrc ?? null });
  return await listarOcorrenciasNF(sessao, detalhe);
}

/** Marca 'nao_rodou' (sem lançar) + card_event explicativo. */
// deno-lint-ignore no-explicit-any
async function marcarSemAcao(supabase: any, cardId: string, motivo: string, ocRealSsw: number | null): Promise<void> {
  const texto = motivo === "sem_oc_anterior"
    ? "Não lancei: a oc 43 é a primeira ocorrência do SSW (sem oc anterior). Deixe a operadora escolher."
    : motivo === "oc_mudou_no_ssw"
    ? `Não lancei: o SSW já mostra a oc ${ocRealSsw} (saiu de 43). Verifique.`
    : "Não lancei: o SSW não retornou ocorrências pra essa NF.";
  await supabase.from("cards").update({
    agente_oc43_status: "nao_rodou",
    agente_oc43_motivo: texto,
    agente_oc43_oc_anterior: null,
    agente_oc43_checado_em: new Date().toISOString(),
  }).eq("id", cardId);
  await supabase.from("card_events").insert({
    card_id: cardId, event_type: "AgenteOc43NaoRodou", actor_type: "agent", actor_id: AGENT_NAME,
    payload: { motivo, oc_real_ssw: ocRealSsw, texto },
  });
}

/** Marca 'erro' + card_event (falha no lançamento — não trava o card). */
// deno-lint-ignore no-explicit-any
async function marcarErro(supabase: any, cardId: string, erro: string): Promise<void> {
  await supabase.from("cards").update({
    agente_oc43_status: "erro",
    agente_oc43_motivo: erro,
    agente_oc43_checado_em: new Date().toISOString(),
  }).eq("id", cardId);
  await supabase.from("card_events").insert({
    card_id: cardId, event_type: "AgenteOc43Erro", actor_type: "agent", actor_id: AGENT_NAME,
    payload: { erro },
  });
}

/** Lança a oc (49 ou 55) via envelope: monta o todo → auto_aprovar_e_executar →
 *  executor (tripé + idempotência) → cancela demais propostas → status/evento/auditoria. */
// deno-lint-ignore no-explicit-any
async function lancarOc43(
  supabase: any,
  card: CardOc43,
  codigoSsw: 49 | 55,
  ocAnterior: number,
  ocAnteriorDesc: string,
): Promise<{ ok: boolean; erro?: string; todoId?: string }> {
  const cnpjRemetente = (card.agent_state?.["cnpj_remetente"] as string | null) ?? null;
  const proposta = montarPropostaOc43({ codigoSsw, nf: card.nf, cnpjRemetente, ocAnterior, ocAnteriorDesc });
  const acao = codigoSsw === 49 ? "lancar_49" : "lancar_55";
  const label = `Lançar oc ${codigoSsw} (autônomo oc43) — anterior oc ${ocAnterior}`;

  // A oc 43 JÁ cria uma proposta pendente de oc 55 (REGRAS_AUTO_ACAO[43]). Dar
  // INSERT de outro 55 colidiria no índice único `uniq_todos_card_tool_cod_ativo`
  // (card_id, tool, codigo_ssw WHERE status IN pendente/aprovado). Então REUSA a
  // proposta existente (mesma tool+cod → sem colisão) sobrescrevendo o payload com
  // o texto contextualizado; pra 49 (sem proposta prévia) → INSERT. Espelha o
  // find-or-recreate do agente-extravio-d4. NÃO cancelo os irmãos antes de aprovar
  // (se o auto_aprovar falhar, o card mantém as opções manuais intactas).
  const { data: existente } = await supabase.from("todos")
    .select("id").eq("card_id", card.id).eq("status", "pendente")
    .eq("proposta_payload->>tool", "lancar_ocorrencia")
    .eq("proposta_payload->args->>codigo_ssw", String(codigoSsw))
    .maybeSingle();

  let todoId = (existente as { id?: string } | null)?.id ?? null;
  if (todoId) {
    const { error: updErr } = await supabase.from("todos")
      .update({ descricao: label, proposta_payload: proposta })
      .eq("id", todoId);
    if (updErr) return { ok: false, erro: `NF ${card.nf}: UPDATE todo oc ${codigoSsw}: ${updErr.message}` };
  } else {
    const { data: novo, error: insErr } = await supabase.from("todos").insert({
      card_id: card.id,
      action_id: crypto.randomUUID(),
      descricao: label,
      status: "pendente",
      proposta_payload: proposta,
    }).select("id").single();
    if (insErr || !novo) return { ok: false, erro: `NF ${card.nf}: INSERT todo: ${insErr?.message ?? "todo nulo"}` };
    todoId = (novo as { id: string }).id;
  }

  const { error: rpcErr } = await supabase.rpc("auto_aprovar_e_executar", {
    p_todo_id: todoId, p_regra: `agente_oc43_${acao}`,
  });
  if (rpcErr) {
    // Card pode ter saído de AVH (operador antecipou). Não deleto o todo (é uma
    // proposta legítima do card — reusada ou recém-criada); só reporto o erro.
    return { ok: false, erro: `NF ${card.nf}: auto_aprovar: ${rpcErr.message}` };
  }

  // Cancela as demais propostas pendentes da 43 (igual aprovação humana faz).
  await supabase.from("todos").update({
    status: "cancelado",
    rejection_reason: `Agente oc43 lançou oc ${codigoSsw} — demais propostas canceladas`,
  }).eq("card_id", card.id).eq("status", "pendente");

  await supabase.from("cards").update({
    agente_oc43_status: codigoSsw === 49 ? "lancou_49" : "lancou_55",
    agente_oc43_oc_anterior: ocAnterior,
    agente_oc43_checado_em: new Date().toISOString(),
  }).eq("id", card.id);
  await supabase.from("card_events").insert({
    card_id: card.id, event_type: "AgenteOc43Lancou", actor_type: "agent", actor_id: AGENT_NAME,
    payload: { codigo_ssw: codigoSsw, oc_anterior: ocAnterior, todo_id: todoId, regra: `agente_oc43_${acao}` },
  });
  await snapshotAuditoriaOc43(supabase, card.id, codigoSsw, ocAnterior);
  return { ok: true, todoId };
}

/** Snapshot na aba AUDITORIA (motivo distinto pro filtro). Idempotente por
 *  (card, motivo). Espelha snapshotAuditoriaExtravio. */
// deno-lint-ignore no-explicit-any
async function snapshotAuditoriaOc43(supabase: any, cardId: string, codigoSsw: number, ocAnterior: number): Promise<void> {
  const motivo = "oc43_autonomo";
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
    card_snapshot: { ...card, _agente: "oc43_autonomo", _oc_lancada: codigoSsw, _oc_anterior: ocAnterior },
    todos_snapshot: todos ?? [], events_snapshot: events ?? [],
  });
  await supabase.from("cards").update({
    em_auditoria: true, auditoria_motivo: motivo, auditoria_added_at: new Date().toISOString(),
  }).eq("id", cardId);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
