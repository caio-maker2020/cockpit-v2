// =============================================================================
// agente-seguir-parcial-auto — lança a oc 55 sozinho para clientes com
// AUTORIZAÇÃO PERMANENTE de seguir parcial (ADR 0025). Cron.
//
// POR QUE UMA FUNÇÃO NOVA, e não um enxerto no sync-bastao / regras-auto-acao:
// o pedido do Caio (03/09) é "não afetar os demais clientes". Enxertar no sync
// significaria rodar código novo no caminho de TODOS os cards, todo ciclo. Aqui
// o filtro por whitelist acontece no PRÓPRIO SELECT: cliente fora da lista nunca
// é sequer lido. Blast radius fora dos CNPJs autorizados = zero por construção.
// Molde: agente-oc13-autonomo (exceção por CNPJ) + agente-extravio-d4
// (pré-checagem SSW obrigatória antes de todo lançamento).
//
// CAMADAS QUE PRECISAM PASSAR (todas, em ordem):
//   1. feature_flags.seguir_parcial_auto_enabled = true (nasce OFF, mig 377);
//   2. CNPJ em cliente_config_seguir_parcial_auto com ativo=true (nascem false);
//   3. aplica_oc06 / aplica_oc08 do cliente;
//   4. oc 06 → SEM sinal de extravio total (ADR 0025 D2);
//   5. horário comercial BRT (force ignora);
//   6. PRÉ-CHECAGEM SSW no mesmo ciclo: a última oc REAL ainda tem de ser a
//      mesma do card. Mudou → não lança, registra e devolve pro operador;
//   7. idempotência: 55 já executada com sucesso neste card → skip.
//
// MODO SOMBRA (F7): feature_flags.seguir_parcial_auto_sombra. Decide, grava
// `SeguirParcialAutoSimulado` e NÃO lança. FAIL-SAFE: ausente/erro = sombra ON.
// Só sai da sombra com a linha existindo e enabled=false explícito.
//
// INV-001: SSW interno (nunca tracking público). INV-009: verify_jwt=false.
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
  decidirSeguirParcialAuto,
  type MotivoNaoAplica,
  TEXTO_SSW_55,
} from "../_shared/seguir-parcial-auto.ts";
import { carregarContextoSeguirParcial } from "../_shared/seguir-parcial-carregar.ts";
import { acaoKey } from "../_shared/regras-auto-acao.ts";

const AGENT_NAME = "agente-seguir-parcial-auto";
const MAX_CARDS = 50;
const TIME_BUDGET_MS = 110_000;

/** Estados de onde o card pode sair via 55 automática. Qualquer outro estado
 *  significa que ALGUÉM (operador ou outro agente) já está mexendo — não toca.
 *  INV-007. */
const ESTADOS_ELEGIVEIS: Record<number, string> = {
  6: "EXTRAVIO_MONITORADO",
  8: "AGUARDANDO_VALIDACAO_HUMANA",
};

/** Janela pós-lançamento: se o Cockpit agiu neste card há pouco, o Bastão pode
 *  estar stale. Mesma régua do sync-bastao (Risco 3). */
const JANELA_POS_ACAO_MS = 60 * 60_000;

interface CardCandidato {
  id: string;
  nf: string | null;
  ctrc: string | null;
  state: string;
  cod_ultima_ocorrencia: number | null;
  qtde_volumes: number | null;
  acao_executada_em: string | null;
  agent_state: Record<string, unknown> | null;
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ ok: false, error: "POST/GET esperado" }, 405);
  }

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

  // ── Camadas 1 e 2 ─────────────────────────────────────────────────────────
  const ctx = await carregarContextoSeguirParcial(supabase);
  if (!ctx.flagOn) return json({ ok: true, skipped: "flag_off" }, 200);
  if (ctx.whitelist.size === 0) return json({ ok: true, skipped: "whitelist_vazia" }, 200);

  // ── Camada 5 ──────────────────────────────────────────────────────────────
  if (!force && !isHorarioComercialBRT(new Date())) {
    return json({ ok: true, skipped: "fora_horario_comercial" }, 200);
  }

  const cnpjsAtivos = [...ctx.whitelist.keys()];
  const candidatos = await buscarCandidatos(supabase, cnpjsAtivos, limit);
  if (candidatos.length === 0) {
    return json({
      ok: true,
      sombra: ctx.sombra,
      candidatos: 0,
      duration_ms: Date.now() - startedAt,
    }, 200);
  }

  // Sessão SSW só depois de saber que há trabalho — login é caro.
  const sessao = await obterSessao(readSswInternalEnv(env));

  const lancados: Array<Record<string, unknown>> = [];
  const simulados: Array<Record<string, unknown>> = [];
  const naoAplicou: Array<Record<string, unknown>> = [];
  const erros: string[] = [];

  for (const card of candidatos) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      erros.push("time budget — restantes ficam pro próximo ciclo");
      break;
    }
    const run = startAgentRun({
      agentName: AGENT_NAME,
      stepName: ctx.sombra ? "sombra" : "executar",
      cardId: card.id,
      input: { nf: card.nf, oc: card.cod_ultima_ocorrencia },
    });
    try {
      const r = await processarCard(supabase, sessao, ctx, card);
      if (r.tipo === "lancado") {
        lancados.push({ card_id: card.id, nf: card.nf, oc: card.cod_ultima_ocorrencia });
        await finishAgentRun(supabase, run, { status: "success", output: r });
      } else if (r.tipo === "simulado") {
        simulados.push({ card_id: card.id, nf: card.nf, oc: card.cod_ultima_ocorrencia });
        await finishAgentRun(supabase, run, { status: "success", output: r });
      } else {
        naoAplicou.push({ card_id: card.id, nf: card.nf, motivo: r.motivo });
        await finishAgentRun(supabase, run, { status: "success", output: r });
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      erros.push(`card ${card.id} (NF ${card.nf}): ${m}`);
      await finishAgentRun(supabase, run, { status: "error", errorMessage: m });
    }
  }

  return json({
    ok: true,
    sombra: ctx.sombra,
    candidatos: candidatos.length,
    lancados_count: lancados.length,
    simulados_count: simulados.length,
    nao_aplicou_count: naoAplicou.length,
    erros_count: erros.length,
    lancados,
    simulados,
    nao_aplicou: naoAplicou,
    erros,
    duration_ms: Date.now() - startedAt,
  }, 200);
});

// ---------------------------------------------------------------------------

/** Candidatos: SÓ cards dos CNPJs autorizados, no estado esperado da sua oc.
 *  O filtro por CNPJ vai no SELECT de propósito — cliente fora da whitelist
 *  nunca é lido por esta função. */
// deno-lint-ignore no-explicit-any
async function buscarCandidatos(
  supabase: any,
  cnpjsAtivos: string[],
  limit: number,
): Promise<CardCandidato[]> {
  const campos =
    "id, nf, ctrc, state, cod_ultima_ocorrencia, qtde_volumes, acao_executada_em, agent_state";
  const out: CardCandidato[] = [];
  for (const [ocStr, state] of Object.entries(ESTADOS_ELEGIVEIS)) {
    const oc = Number(ocStr);
    const { data, error } = await supabase
      .from("cards")
      .select(campos)
      .eq("state", state)
      .eq("cod_ultima_ocorrencia", oc)
      .in("agent_state->>cnpj_pagador", cnpjsAtivos)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`SELECT candidatos oc=${oc}: ${error.message}`);
    out.push(...((data ?? []) as CardCandidato[]));
  }
  return out.slice(0, limit);
}

type Resultado =
  | { tipo: "lancado"; todo_id: string }
  | { tipo: "simulado"; oc: number }
  | { tipo: "nao_aplicou"; motivo: MotivoNaoAplica | string };

// deno-lint-ignore no-explicit-any
async function processarCard(
  supabase: any,
  sessao: SswSessao,
  // deno-lint-ignore no-explicit-any
  ctx: any,
  card: CardCandidato,
): Promise<Resultado> {
  const st = card.agent_state ?? {};
  const oc = card.cod_ultima_ocorrencia;
  if (!card.nf) return { tipo: "nao_aplicou", motivo: "card_sem_nf" };

  // Janela pós-ação: o Cockpit mexeu aqui há pouco, o snapshot pode estar velho.
  if (card.acao_executada_em) {
    const t = new Date(card.acao_executada_em).getTime();
    if (Number.isFinite(t) && Date.now() - t < JANELA_POS_ACAO_MS) {
      return { tipo: "nao_aplicou", motivo: "acao_recente_no_card" };
    }
  }

  // ── Camada 7: idempotência ────────────────────────────────────────────────
  const { data: ja } = await supabase
    .from("acoes_executadas_ssw")
    .select("id")
    .eq("card_id", card.id)
    .eq("codigo_oc", 55)
    .eq("sucesso", true)
    .limit(1)
    .maybeSingle();
  if (ja) return { tipo: "nao_aplicou", motivo: "55_ja_executada" };

  // ── Camadas 2/3/4: a decisão pura ─────────────────────────────────────────
  const decisao = decidirSeguirParcialAuto({
    flagOn: ctx.flagOn,
    oc,
    cnpjPagador: (st["cnpj_pagador"] as string | null) ?? null,
    cnpjRemetente: (st["cnpj_remetente"] as string | null) ?? null,
    instrucao: (st["instrucao_ultima_ocorrencia"] as string | null) ?? null,
    qtdVolumesNf: card.qtde_volumes ??
      (st["qtde_volumes"] != null ? Number(st["qtde_volumes"]) : null),
    whitelist: ctx.whitelist,
  });
  if (!decisao.aplica) {
    await registrarEvento(supabase, card.id, "SeguirParcialAutoNaoAplicou", {
      oc,
      motivo: decisao.motivo,
      instrucao: st["instrucao_ultima_ocorrencia"] ?? null,
      qtde_volumes: card.qtde_volumes ?? null,
    });
    return { tipo: "nao_aplicou", motivo: decisao.motivo };
  }

  // ── Camada 6: pré-checagem SSW OBRIGATÓRIA, no mesmo ciclo ────────────────
  const { ocReal, ultima } = await ultimaOcSsw(sessao, card.nf, card.ctrc);
  if (ocReal == null) return { tipo: "nao_aplicou", motivo: "ssw_sem_oc" };
  if (ocReal !== oc) {
    const motivo = `Não lancei a oc 55: o SSW já mostra a ocorrência ${ocReal}` +
      `${ultima?.descricao ? ` (${ultima.descricao})` : ""}` +
      `${ultima?.data ? ` lançada em ${ultima.data}` : ""} — depois da oc ${oc} do card. ` +
      `Alguém já agiu; a decisão volta pro operador.`;
    await registrarEvento(supabase, card.id, "SeguirParcialAutoNaoAplicou", {
      oc,
      motivo: "ssw_divergente",
      oc_achada: ocReal,
      detalhe: motivo,
    });
    return { tipo: "nao_aplicou", motivo: "ssw_divergente" };
  }

  // ── MODO SOMBRA (F7): decide, registra, NÃO lança ─────────────────────────
  if (ctx.sombra) {
    await registrarEvento(supabase, card.id, "SeguirParcialAutoSimulado", {
      oc,
      cnpj: decisao.cnpj,
      teria_lancado: 55,
      texto_ssw: decisao.texto_ssw,
      instrucao: st["instrucao_ultima_ocorrencia"] ?? null,
      qtde_volumes: card.qtde_volumes ?? null,
      oc_real_ssw: ocReal,
    });
    return { tipo: "simulado", oc: oc! };
  }

  // ── Lançamento real ───────────────────────────────────────────────────────
  const todoId = await garantirTodo55(supabase, card, decisao.texto_ssw);
  const regra = `seguir_parcial_auto:oc${oc}`;
  const { error: rpcErr } = await supabase.rpc("auto_aprovar_e_executar", {
    p_todo_id: todoId,
    p_regra: regra,
  });
  if (rpcErr) {
    // Card pode ter saído do estado (operador antecipou) — trata sem escândalo.
    if (/EXECUTANDO_ACAO|state|approval/i.test(rpcErr.message)) {
      await registrarEvento(supabase, card.id, "SeguirParcialAutoNaoAplicou", {
        oc,
        motivo: "operador_antecipou",
        erro: rpcErr.message,
      });
      return { tipo: "nao_aplicou", motivo: "operador_antecipou" };
    }
    throw new Error(`auto_aprovar_e_executar: ${rpcErr.message}`);
  }

  // As demais propostas do ciclo perdem o sentido: o caminho foi escolhido.
  // Só as do MESMO card e só as pendentes — nunca toca ação in-flight.
  await supabase
    .from("todos")
    .update({
      status: "cancelado",
      rejection_reason:
        "Cliente com autorização permanente de seguir parcial (ADR 0025) — oc 55 lançada automaticamente",
    })
    .eq("card_id", card.id)
    .eq("status", "pendente")
    .neq("id", todoId);

  await registrarEvento(supabase, card.id, "SeguirParcialAutoLancou55", {
    oc,
    cnpj: decisao.cnpj,
    todo_id: todoId,
    regra,
    texto_ssw: decisao.texto_ssw,
    oc_real_ssw: ocReal,
  });
  return { tipo: "lancado", todo_id: todoId };
}

/** Acha o todo ATIVO de oc 55 do card (qualquer tool) e garante que ele carrega
 *  o texto da autorização. Se não houver, cria. NUNCA cria gêmeo — o índice
 *  uniq_todos_card_tool_cod_ativo não perdoa. */
// deno-lint-ignore no-explicit-any
async function garantirTodo55(
  supabase: any,
  card: CardCandidato,
  textoSsw: string,
): Promise<string> {
  const { data: todos } = await supabase
    .from("todos")
    .select("id, status, proposta_payload")
    .eq("card_id", card.id)
    .in("status", ["pendente", "aprovado"]);

  const alvo = ((todos ?? []) as Array<Record<string, unknown>>).find((t) => {
    const pp = t["proposta_payload"] as Record<string, unknown> | null;
    const args = (pp?.["args"] ?? {}) as Record<string, unknown>;
    return Number(args["codigo_ssw"]) === 55;
  });

  if (alvo) {
    const id = alvo["id"] as string;
    const pp = (alvo["proposta_payload"] ?? {}) as Record<string, unknown>;
    const args = (pp["args"] ?? {}) as Record<string, unknown>;
    const extras = (args["extras"] ?? {}) as Record<string, unknown>;
    // Carimba o motivo real no texto que vai pro SSW: o histórico precisa dizer
    // que a autorização é de cadastro, não de uma resposta do cliente nesta NF.
    if (extras["texto_descricao"] !== textoSsw) {
      await supabase
        .from("todos")
        .update({
          proposta_payload: {
            ...pp,
            args: { ...args, extras: { ...extras, texto_descricao: textoSsw } },
          },
        })
        .eq("id", id);
    }
    return id;
  }

  const { data: novo, error } = await supabase
    .from("todos")
    .insert({
      card_id: card.id,
      action_id: crypto.randomUUID(),
      descricao: "Lançar oc 55 — cliente com autorização permanente de seguir parcial",
      status: "pendente",
      proposta_payload: {
        tool: "lancar_ocorrencia",
        acao_key: acaoKey("lancar_ocorrencia", 55),
        args: {
          nf: card.nf,
          codigo_ssw: 55,
          cnpj_remetente:
            ((card.agent_state ?? {})["cnpj_remetente"] as string | null) ?? null,
          descricao: textoSsw,
          extras: { enviar_email: false, texto_descricao: textoSsw },
        },
        rationale:
          "ADR 0025: cliente autoriza em cadastro seguir parcial mesmo com avaria/extravio parcial. " +
          "Lançamento autônomo, sem notificar nem perguntar.",
        texto: null,
        meta: {
          origem: "seguir_parcial_auto",
          acao: "lancar_55",
          tinha_intencao_email: false,
          modo: "sem_email",
          criada_pelo_agente: true,
        },
      },
    })
    .select("id")
    .single();
  if (error) throw new Error(`criar todo 55: ${error.message}`);
  return (novo as { id: string }).id;
}

/** Última oc REAL no SSW (a primeira com código). Espelha o agente-extravio-d4. */
async function ultimaOcSsw(
  sessao: SswSessao,
  nf: string,
  ctrc: string | null,
): Promise<{ ocReal: number | null; ultima: SswOcorrencia | null }> {
  const detalhe = await buscarNFInterno(sessao, nf, { ctrcEsperado: ctrc ?? null });
  const ocs = await listarOcorrenciasNF(sessao, detalhe);
  const comCodigo = ocs.filter((o) => o.codigo != null);
  const ultima = comCodigo[0] ?? null;
  return { ocReal: ultima?.codigo ?? null, ultima };
}

// deno-lint-ignore no-explicit-any
async function registrarEvento(
  supabase: any,
  cardId: string,
  tipo: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: tipo,
    actor_type: "agent",
    actor_id: AGENT_NAME,
    payload,
  });
}

function cors(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}
