// =============================================================================
// agente-ressarcimento-relancar-54 — detecta o round-trip de ressarcimento e
// sugere/relança SÓ a oc 54.
//
// Caio 2026-06-25 (NF 374609, 775461): cliente notificado (oc 54) → Ressarcimento
// analisa (oc 46) → Ressarcimento devolve pro relacionamento (oc 49) mandando
// RELANÇAR 54. Ação: relançar só a oc 54 (sem e-mail — cliente já foi notificado),
// pra manter o card aguardando o cliente enquanto o ressarcimento corre.
//
// Detector puro: _shared/ressarcimento-relancar-54.ts (54→46→49, 54 ANTES da 46
// obrigatória). Dois tiers:
//   - A (determinístico): a 49 manda relançar 54 explicitamente → recomenda direto.
//   - B (interpretação): a 49 (mesma pessoa do ressarcimento) pede romaneio/valor
//     sem dizer "54" → o agente lê o e-mail original da 54: se pediu esses docs e
//     o cliente NÃO respondeu (cards.cliente_respondeu_em IS NULL) → recomenda.
//
// Modos:
//   - "scan" (cron): roda o detector nos cards parados na oc 49. Marca
//     'recomendado' (cria a proposta lançar-só-54-sem-email) / 'nao_rodou' /
//     'nao_aplica'. NÃO lança até a flag de autonomia.
//   - "execute" {card_ids:[...]}: re-valida o detector e RELANÇA a 54 nos cards
//     aprovados pelo Caio (validação por lote). No autônomo, o scan chama o mesmo
//     caminho.
//
// Gated por feature_flags.ressarcimento_relancar54_enabled + horário comercial BRT.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { isHorarioComercialBRT } from "../_shared/horario-comercial.ts";
import { startAgentRun, finishAgentRun } from "../_shared/agent-runs-logger.ts";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";
import {
  detectarRessarcimentoRelancar54,
  type OcHistorico,
  type RessarcRelancar54Match,
  type RessarcRelancar54Tier,
} from "../_shared/ressarcimento-relancar-54.ts";

const MASTER_FLAG = "ressarcimento_relancar54_enabled";
const AUTONOMO_FLAG = "ressarcimento_relancar54_autonomo_enabled";
const AGENT_NAME = "agente-ressarcimento-relancar-54";
const ORIGEM_PROPOSTA = "ressarcimento_relancar_54";
const ESTADOS_ELEGIVEIS = ["AGUARDANDO_VALIDACAO_HUMANA", "AGUARDANDO_CLIENTE"];
const MAX_CARDS = 80;
const TIME_BUDGET_MS = 110_000;
// Texto que vai pro campo Instrução do SSW (latin-1, <500 chars — sanitizado no envelope).
const DESCRICAO_SSW_54 =
  "AGUARDANDO RETORNO DO CLIENTE PAGADOR - REITERACAO (PROCESSO DE RESSARCIMENTO EM ANALISE)";

interface CardRow {
  id: string;
  nf: string | null;
  ctrc: string | null;
  state: string | null;
  responsavel_relacionamento: string | null;
  cliente_respondeu_em: string | null;
  historico_ssw: OcHistorico[] | null;
  historico_ssw_atualizado_em: string | null;
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
  const limit = Number.isFinite(body?.limit)
    ? Math.max(1, Math.min(MAX_CARDS, Number(body.limit)))
    : MAX_CARDS;

  // Gate: master flag.
  const { data: flag } = await supabase
    .from("feature_flags").select("enabled").eq("key", MASTER_FLAG).maybeSingle();
  if (!(flag as { enabled?: boolean } | null)?.enabled) {
    return json({ ok: true, skipped: "flag_off" }, 200);
  }
  // Gate: horário comercial BRT. force ignora (pra rodar o scan manual agora).
  if (!force && !isHorarioComercialBRT(new Date())) {
    return json({ ok: true, skipped: "fora_horario_comercial" }, 200);
  }

  const { data: flagAut } = await supabase
    .from("feature_flags").select("enabled").eq("key", AUTONOMO_FLAG).maybeSingle();
  const autonomo = (flagAut as { enabled?: boolean } | null)?.enabled === true;

  if (mode === "execute") {
    return await runExecute(supabase, env, body?.card_ids ?? [], startedAt);
  }
  return await runScan(supabase, env, supabaseUrl, serviceRoleKey, limit, startedAt, autonomo);
});

// ---------------------------------------------------------------------------
// SCAN — roda o detector nos cards parados na oc 49.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function runScan(supabase: any, env: Record<string, string | undefined>, supabaseUrl: string, serviceRoleKey: string, limit: number, startedAt: number, autonomo: boolean): Promise<Response> {
  const { data: rows, error: selErr } = await supabase
    .from("cards")
    .select("id, nf, ctrc, state, responsavel_relacionamento, cliente_respondeu_em, historico_ssw, historico_ssw_atualizado_em")
    .eq("cod_ultima_ocorrencia", 49)
    .in("state", ESTADOS_ELEGIVEIS)
    .is("ressarc54_status", null)
    .limit(limit);
  if (selErr) return json({ ok: false, error: `SELECT elegíveis: ${selErr.message}` }, 500);

  // Reconciliação: credita "lançou" os cards recomendados cuja 54 foi relançada PELO
  // COCKPIT (agente OU operador) — senão a auditoria só mostra os lançamentos autônomos.
  const reconciliados = await reconciliarLancamentosOperador(supabase);

  const elegiveis = (rows ?? []) as CardRow[];
  if (elegiveis.length === 0) {
    return json({ ok: true, mode: "scan", elegiveis: 0, reconciliados, nota: "nenhum card oc 49 pendente", duration_ms: Date.now() - startedAt }, 200);
  }

  const recomendados: Array<Record<string, unknown>> = [];
  const lancados: Array<Record<string, unknown>> = [];
  const naoRodou: Array<Record<string, unknown>> = [];
  const naoAplica: string[] = [];
  const erros: string[] = [];

  for (const card of elegiveis) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { erros.push("time budget"); break; }
    const run = startAgentRun({ agentName: AGENT_NAME, stepName: autonomo ? "scan_autonomo" : "scan", cardId: card.id, input: { nf: card.nf } });
    try {
      // Autônomo re-puxa o histórico FRESCO do SSW antes de decidir (não age em cache velho).
      const historico = await obterHistorico(supabase, supabaseUrl, serviceRoleKey, card, autonomo);
      const match = detectarRessarcimentoRelancar54(historico);

      if (!match) {
        await marcarNaoAplica(supabase, card.id);
        naoAplica.push(card.nf ?? card.id);
        await finishAgentRun(supabase, run, { status: "success", output: { decisao: "nao_aplica" } });
        continue;
      }

      // Tier B precisa interpretação do e-mail original da 54.
      if (match.tier === "B") {
        const verdict = await interpretarTierB(supabase, env, card);
        if (!verdict.confirma) {
          await flagNaoRodou(supabase, card.id, "B", verdict.motivo);
          naoRodou.push({ card_id: card.id, nf: card.nf, tier: "B", motivo: verdict.motivo, operador: card.responsavel_relacionamento });
          await finishAgentRun(supabase, run, { status: "success", output: { decisao: "nao_rodou", tier: "B" } });
          continue;
        }
      }

      // Autônomo SÓ pra Tier A (determinístico — a 49 manda relançar 54 explícito;
      // validado 100% pelo Caio 2026-06-25). Tier B NUNCA lança sozinho: vira
      // sugestão no card pro operador validar/aprovar na mão.
      if (autonomo && match.tier === "A") {
        const r = await relancar54(supabase, card, match);
        if (!r.ok) { erros.push(r.erro!); await finishAgentRun(supabase, run, { status: "error", errorMessage: r.erro }); continue; }
        lancados.push({ card_id: card.id, nf: card.nf, tier: match.tier, operador: card.responsavel_relacionamento });
        await finishAgentRun(supabase, run, { status: "success", output: { decisao: "lancou_54", tier: match.tier, todo_id: r.todoId } });
        continue;
      }

      const r = await recomendar(supabase, card, match);
      if (!r.ok) { erros.push(r.erro!); await finishAgentRun(supabase, run, { status: "error", errorMessage: r.erro }); continue; }
      recomendados.push({ card_id: card.id, nf: card.nf, tier: match.tier, operador: card.responsavel_relacionamento });
      await finishAgentRun(supabase, run, { status: "success", output: { decisao: "recomendado", tier: match.tier } });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      erros.push(`NF ${card.nf}: ${m}`);
      await finishAgentRun(supabase, run, { status: "error", errorMessage: m });
    }
  }

  return json({
    ok: true, mode: "scan", autonomo, elegiveis: elegiveis.length,
    recomendados_count: recomendados.length, lancados_count: lancados.length,
    nao_rodou_count: naoRodou.length, nao_aplica_count: naoAplica.length, erros_count: erros.length,
    recomendados, lancados, nao_rodou: naoRodou, nao_aplica: naoAplica, erros, reconciliados,
    duration_ms: Date.now() - startedAt,
  }, 200);
}

// ---------------------------------------------------------------------------
// Reconciliação — cards que o agente RECOMENDOU e cuja 54 foi relançada PELO
// COCKPIT (agente OU operador clicando "aprovar") depois da recomendação, mas que
// ainda não têm o evento Lancou. Credita "lançou" na auditoria (crédito de acerto).
// Distingue a 54 RELANÇADA da 54 ORIGINAL via iniciado_em >= 1ª recomendação.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function reconciliarLancamentosOperador(supabase: any): Promise<number> {
  const { data: recEvents } = await supabase
    .from("card_events")
    .select("card_id, payload, created_at")
    .eq("event_type", "RessarcRelancar54Recomendou")
    .order("created_at", { ascending: true });
  if (!recEvents || recEvents.length === 0) return 0;

  const firstRec = new Map<string, { quando: string; tier: string | null }>();
  for (const e of recEvents as Array<Record<string, unknown>>) {
    const cid = e.card_id as string;
    if (!firstRec.has(cid)) {
      firstRec.set(cid, { quando: e.created_at as string, tier: ((e.payload as Record<string, unknown> | null)?.["tier"] as string | null) ?? null });
    }
  }

  const { data: lancEvents } = await supabase
    .from("card_events").select("card_id").eq("event_type", "RessarcRelancar54Lancou");
  const jaLancou = new Set((lancEvents ?? []).map((e: Record<string, unknown>) => e.card_id as string));

  let n = 0;
  for (const [cardId, rec] of firstRec) {
    if (jaLancou.has(cardId)) continue;
    const { data: acao } = await supabase
      .from("acoes_executadas_ssw")
      .select("iniciado_em, todo_id")
      .eq("card_id", cardId).eq("codigo_oc", 54).eq("sucesso", true)
      .gte("iniciado_em", rec.quando)
      .order("iniciado_em", { ascending: false }).limit(1).maybeSingle();
    if (!acao) continue;

    const tier = (rec.tier === "A" || rec.tier === "B") ? rec.tier : "A";
    await supabase.from("cards").update({
      ressarc54_status: "lancou", ressarc54_tier: tier, ressarc54_checado_em: new Date().toISOString(),
    }).eq("id", cardId);
    await supabase.from("card_events").insert({
      card_id: cardId, event_type: "RessarcRelancar54Lancou", actor_type: "system", actor_id: AGENT_NAME,
      payload: { tier, por_operador: true, via: "cockpit", todo_id: (acao as { todo_id?: string }).todo_id ?? null, reconciliado: true },
    });
    // NÃO faz snapshot na cards_auditoria: a aba "LANÇADOS AUTÔNOMOS" é SÓ do robô.
    // O lançamento do operador fica creditado no painel/timeline (👤), não na lista de autônomos.
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// EXECUTE — re-valida o detector e RELANÇA a 54 nos card_ids aprovados.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function runExecute(supabase: any, env: Record<string, string | undefined>, cardIdsRaw: unknown, startedAt: number): Promise<Response> {
  const cardIds = Array.isArray(cardIdsRaw) ? cardIdsRaw.filter((x) => typeof x === "string") as string[] : [];
  if (cardIds.length === 0) return json({ ok: false, error: "execute exige card_ids: [...]" }, 400);

  const supabaseUrl = env["SUPABASE_URL"]!;
  const serviceRoleKey = env["SUPABASE_SERVICE_ROLE_KEY"]!;

  const { data: cards } = await supabase
    .from("cards")
    .select("id, nf, ctrc, state, responsavel_relacionamento, cliente_respondeu_em, historico_ssw, historico_ssw_atualizado_em")
    .in("id", cardIds);
  const cardById = new Map((cards ?? []).map((c: CardRow) => [c.id, c]));

  const lancados: Array<Record<string, unknown>> = [];
  const naoRodou: Array<Record<string, unknown>> = [];
  const erros: string[] = [];

  for (const cardId of cardIds) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { erros.push("time budget"); break; }
    const card = cardById.get(cardId) as CardRow | undefined;
    const run = startAgentRun({ agentName: AGENT_NAME, stepName: "execute", cardId, input: {} });
    try {
      if (!card) { erros.push(`card ${cardId} não encontrado`); await finishAgentRun(supabase, run, { status: "error", errorMessage: "card não encontrado" }); continue; }

      // RE-VALIDA com histórico fresco (pode ter andado desde a recomendação).
      const historico = await obterHistorico(supabase, supabaseUrl, serviceRoleKey, card, true);
      const match = detectarRessarcimentoRelancar54(historico);
      if (!match) {
        await flagNaoRodou(supabase, cardId, null, "Na re-validação o padrão 54→46→49 não bate mais (caso andou no SSW).");
        naoRodou.push({ card_id: cardId, nf: card.nf, motivo: "padrão não bate mais" });
        await finishAgentRun(supabase, run, { status: "success", output: { decisao: "nao_rodou" } });
        continue;
      }
      if (match.tier === "B") {
        const verdict = await interpretarTierB(supabase, env, card);
        if (!verdict.confirma) {
          await flagNaoRodou(supabase, cardId, "B", verdict.motivo);
          naoRodou.push({ card_id: cardId, nf: card.nf, tier: "B", motivo: verdict.motivo });
          await finishAgentRun(supabase, run, { status: "success", output: { decisao: "nao_rodou", tier: "B" } });
          continue;
        }
      }

      const r = await relancar54(supabase, card, match);
      if (!r.ok) { erros.push(r.erro!); await finishAgentRun(supabase, run, { status: "error", errorMessage: r.erro }); continue; }
      lancados.push({ card_id: cardId, nf: card.nf, tier: match.tier });
      await finishAgentRun(supabase, run, { status: "success", output: { decisao: "lancou_54", tier: match.tier, todo_id: r.todoId } });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      erros.push(`card ${cardId}: ${m}`);
      await finishAgentRun(supabase, run, { status: "error", errorMessage: m });
    }
  }

  return json({ ok: true, mode: "execute", pedidos: cardIds.length, lancados_count: lancados.length, nao_rodou_count: naoRodou.length, erros_count: erros.length, lancados, nao_rodou: naoRodou, erros, duration_ms: Date.now() - startedAt }, 200);
}

// ---------------------------------------------------------------------------
// Histórico SSW — usa o cache do card; refaz se faltar ou se forçado.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function obterHistorico(supabase: any, supabaseUrl: string, serviceRoleKey: string, card: CardRow, forcar = false): Promise<OcHistorico[]> {
  if (!forcar && Array.isArray(card.historico_ssw) && card.historico_ssw.length > 0) {
    return card.historico_ssw;
  }
  // Puxa fresco do SSW (cobre o ponto cego: cards oc 49 sem histórico puxado).
  const res = await fetch(`${supabaseUrl}/functions/v1/puxar-historico-ssw-card`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${serviceRoleKey}`, "apikey": serviceRoleKey, "Content-Type": "application/json" },
    body: JSON.stringify({ card_id: card.id }),
  });
  if (!res.ok) return Array.isArray(card.historico_ssw) ? card.historico_ssw : [];
  const j = await res.json().catch(() => ({})) as { ocorrencias?: OcHistorico[] };
  return Array.isArray(j.ocorrencias) ? j.ocorrencias : (Array.isArray(card.historico_ssw) ? card.historico_ssw : []);
}

// ---------------------------------------------------------------------------
// Tier B — o agente lê o e-mail original da 54 e decide se "relançar 54" é a ação.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function interpretarTierB(supabase: any, env: Record<string, string | undefined>, card: CardRow): Promise<{ confirma: boolean; motivo: string }> {
  // Determinístico: se o cliente já respondeu, NÃO é só relançar 54 — há resposta a tratar.
  if (card.cliente_respondeu_em) {
    return { confirma: false, motivo: "Cliente já respondeu o pedido de documentos — não é só relançar 54." };
  }
  const { data: email } = await supabase
    .from("cards_emails_outbound")
    .select("subject, corpo_renderizado, sent_at")
    .eq("card_id", card.id)
    .order("sent_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!email) {
    return { confirma: false, motivo: "Sem e-mail da 54 registrado no Cockpit pra confirmar que pedimos os documentos ao cliente." };
  }
  const corpo = stripHtml((email as { corpo_renderizado?: string }).corpo_renderizado ?? "").slice(0, 4000);
  const subject = (email as { subject?: string }).subject ?? "";

  let client;
  try {
    client = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });
  } catch {
    // Sem chave Anthropic → não arrisca; não confirma.
    return { confirma: false, motivo: "Interpretação Tier B indisponível (sem ANTHROPIC_API_KEY) — confira manual." };
  }

  const system =
    "Você analisa o round-trip de ressarcimento de uma transportadora. O time de Ressarcimento " +
    "lançou a oc 49 pedindo ROMANEIO / DESCRIÇÃO / VALOR / ITENS / ACAREAÇÃO ao relacionamento. " +
    "A ação só é 'relançar a oc 54' (reiterar a cobrança ao cliente, sem novo e-mail) se o e-mail " +
    "ORIGINAL da oc 54 enviado ao cliente JÁ pedia esses mesmos documentos (romaneio / descrição / " +
    "valor / itens). Se o e-mail pedia OUTRA coisa (ex.: só avisava o extravio sem pedir documentos), " +
    "então relançar 54 NÃO resolve e você responde pediu_docs=false. Responda EXCLUSIVAMENTE JSON: " +
    '{"pediu_docs": boolean, "confianca": number (0..1), "motivo": "frase curta"}.';
  const userMsg = `Assunto do e-mail da 54: ${subject}\n\nCorpo do e-mail da 54:\n${corpo}`;

  try {
    const out = await client.completeJson<{ pediu_docs?: boolean; confianca?: number; motivo?: string }>({
      model: "claude-haiku-4-5",
      system,
      messages: [{ role: "user", content: userMsg }],
      maxTokens: 300,
      temperature: 0,
    });
    const pediu = out.pediu_docs === true;
    const motivo = pediu
      ? `E-mail da 54 já pedia os documentos do ressarcimento e o cliente não respondeu — relançar 54 reitera. ${out.motivo ?? ""}`.trim()
      : `E-mail da 54 não pedia os documentos que o ressarcimento aguarda (${out.motivo ?? "ver e-mail"}).`;
    return { confirma: pediu, motivo };
  } catch (e) {
    return { confirma: false, motivo: `Falha na interpretação Tier B (${e instanceof Error ? e.message : String(e)}) — confira manual.` };
  }
}

// ---------------------------------------------------------------------------
// Proposta lançar-só-54-sem-email (idempotente por origem) + ações de estado.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function acharOuCriarTodo54SemEmail(supabase: any, card: CardRow, tier: RessarcRelancar54Tier): Promise<{ ok: boolean; erro?: string; todoId?: string }> {
  if (!card.nf) return { ok: false, erro: `card ${card.id} sem NF` };
  // Reusa um todo "lançar só 54 sem email" já pendente (nosso OU o gêmeo do menu).
  const { data: existentes } = await supabase
    .from("todos").select("id, status, proposta_payload")
    .eq("card_id", card.id).in("status", ["pendente", "aprovado"]);
  for (const t of (existentes ?? []) as Array<Record<string, unknown>>) {
    const payload = t.proposta_payload as Record<string, unknown> | null;
    const meta = payload?.["meta"] as Record<string, unknown> | undefined;
    const args = payload?.["args"] as Record<string, unknown> | undefined;
    const cod = args?.["codigo_ssw"];
    if (meta?.["origem"] === ORIGEM_PROPOSTA) return { ok: true, todoId: t.id as string };
    if (cod === 54 && meta?.["sem_email_explicito"] === true) return { ok: true, todoId: t.id as string };
  }
  const { data: novo, error } = await supabase
    .from("todos")
    .insert({
      card_id: card.id,
      action_id: crypto.randomUUID(),
      descricao: `Relançar SÓ a oc 54 (sem e-mail) — round-trip de ressarcimento (tier ${tier})`,
      status: "pendente",
      proposta_payload: {
        tool: "lancar_ocorrencia",
        args: { codigo_ssw: 54, nf: card.nf, descricao: DESCRICAO_SSW_54 },
        rationale: "Ressarcimento lançou 46 e devolveu 49 pedindo relançar a 54; cliente já notificado.",
        texto: null,
        meta: {
          origem: ORIGEM_PROPOSTA,
          tier,
          modo: "sem_email",
          sem_email_explicito: true,
          gemeo_de_codigo_email: 54,
        },
      },
    })
    .select("id").single();
  if (error) return { ok: false, erro: `NF ${card.nf}: insert proposta: ${error.message}` };
  return { ok: true, todoId: (novo as { id: string }).id };
}

/** Texto do banner (observacao_orquestrador) a partir do match. */
function montarObservacao(match: RessarcRelancar54Match): string {
  const d46 = match.oc46.data ? ` (em ${match.oc46.data})` : "";
  const d54 = match.oc54.data ? ` lançada em ${match.oc54.data}` : "";
  const fonte = match.tier === "A"
    ? "a própria oc 49 do Ressarcimento manda relançar a 54"
    : "o agente leu o e-mail original da 54 e confirmou que pedimos os documentos e o cliente não respondeu";
  return (
    `🔁 RESSARCIMENTO PEDIU PRA RELANÇAR A 54: o time de Ressarcimento analisou${d46} ` +
    `(oc 46) e devolveu a oc 49 pedindo reiterar a cobrança ao cliente. Como o cliente JÁ ` +
    `foi notificado (oc 54${d54}), a ação é RELANÇAR SÓ a oc 54 (sem e-mail novo). ` +
    `Tier ${match.tier} — ${fonte}.`
  );
}

/** Escreve o banner no card (MESMO contrato do card "RECOMENDADO PELO AGENTE IA":
 *  proposta_destacada + confianca + observacao_orquestrador). O front renderiza com
 *  o componente PADRÃO (Aprovar / Confiança / Ver outras opções / IA acertou-errou),
 *  destacando a proposta "lançar só 54 sem email" do menu. */
// deno-lint-ignore no-explicit-any
async function escreverBanner(supabase: any, card: CardRow, match: RessarcRelancar54Match): Promise<void> {
  // tier A = instrução explícita (alta); tier B = confirmado pelo agente lendo o e-mail.
  const confianca = match.tier === "A" ? 0.95 : 0.82;
  await supabase.from("cards").update({
    aviso_alteracao_oc: {
      tipo: "ressarcimento_relancar_54",
      proposta_destacada: 54,
      // Distingue a proposta "54 sem email" da "54 + email" no destaque/aprovação.
      sem_email: true,
      template_email_sugerido: null,
      tier: match.tier,
      confianca,
      observacao_orquestrador: montarObservacao(match),
      oc46_data: match.oc46.data ?? null,
      oc54_data: match.oc54.data ?? null,
      oc49_instrucao: match.oc49.instrucao ?? null,
      atualizado_em: new Date().toISOString(),
    },
  }).eq("id", card.id);
}

// deno-lint-ignore no-explicit-any
async function recomendar(supabase: any, card: CardRow, match: RessarcRelancar54Match): Promise<{ ok: boolean; erro?: string }> {
  // NÃO cria proposta nova — o card já oferece "lançar só 54 sem email" no menu.
  // A recomendação é o BANNER que destaca essa proposta (igual aos outros agentes).
  await escreverBanner(supabase, card, match);
  await supabase.from("cards").update({
    ressarc54_status: "recomendado", ressarc54_tier: match.tier, ressarc54_motivo: null,
    ressarc54_checado_em: new Date().toISOString(),
  }).eq("id", card.id);
  await supabase.from("card_events").insert({
    card_id: card.id, event_type: "RessarcRelancar54Recomendou", actor_type: "agent", actor_id: AGENT_NAME,
    payload: { tier: match.tier, acao: "relancar_54" },
  });
  return { ok: true };
}

// deno-lint-ignore no-explicit-any
async function relancar54(supabase: any, card: CardRow, match: RessarcRelancar54Match): Promise<{ ok: boolean; erro?: string; todoId?: string }> {
  const tier = match.tier;
  // Autônomo precisa de um todo concreto pra aprovar: reusa o gêmeo sem-email do
  // menu se existir, senão cria um (origem própria). Aprova na hora (sem race com
  // o regenerador de propostas).
  const p = await acharOuCriarTodo54SemEmail(supabase, card, tier);
  if (!p.ok || !p.todoId) return { ok: p.ok, erro: p.erro };
  const { error: rpcErr } = await supabase.rpc("auto_aprovar_e_executar", { p_todo_id: p.todoId, p_regra: AGENT_NAME });
  if (rpcErr) return { ok: false, erro: `NF ${card.nf}: auto_aprovar: ${rpcErr.message}` };
  await escreverBanner(supabase, card, match);
  await supabase.from("cards").update({
    ressarc54_status: "lancou", ressarc54_tier: tier, ressarc54_checado_em: new Date().toISOString(),
  }).eq("id", card.id);
  await supabase.from("card_events").insert({
    card_id: card.id, event_type: "RessarcRelancar54Lancou", actor_type: "agent", actor_id: AGENT_NAME,
    payload: { tier, todo_id: p.todoId, regra: AGENT_NAME },
  });
  await snapshotAuditoria(supabase, card.id, tier);
  return p;
}

// deno-lint-ignore no-explicit-any
async function flagNaoRodou(supabase: any, cardId: string, tier: RessarcRelancar54Tier | null, motivo: string): Promise<void> {
  await supabase.from("cards").update({
    ressarc54_status: "nao_rodou", ressarc54_tier: tier, ressarc54_motivo: motivo,
    ressarc54_checado_em: new Date().toISOString(),
  }).eq("id", cardId);
  await supabase.from("card_events").insert({
    card_id: cardId, event_type: "RessarcRelancar54NaoRodou", actor_type: "agent", actor_id: AGENT_NAME,
    payload: { tier, motivo },
  });
}

// deno-lint-ignore no-explicit-any
async function marcarNaoAplica(supabase: any, cardId: string): Promise<void> {
  await supabase.from("cards").update({
    ressarc54_status: "nao_aplica", ressarc54_checado_em: new Date().toISOString(),
  }).eq("id", cardId);
}

/** Snapshot do card na aba AUDITORIA (motivo distinto). Idempotente por (card, motivo). */
// deno-lint-ignore no-explicit-any
async function snapshotAuditoria(supabase: any, cardId: string, tier: RessarcRelancar54Tier): Promise<void> {
  const motivo = "ressarc54_relancar_autonomo";
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
    card_snapshot: { ...card, _agente: AGENT_NAME, _oc_lancada: 54, _tier: tier },
    todos_snapshot: todos ?? [], events_snapshot: events ?? [],
  });
  await supabase.from("cards").update({
    em_auditoria: true, auditoria_motivo: motivo, auditoria_added_at: new Date().toISOString(),
  }).eq("id", cardId);
}

function stripHtml(s: string): string {
  return s.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
