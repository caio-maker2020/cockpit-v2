// =============================================================================
// sync-extravios-bastao — SAÍDA da aba EXTRAVIOS pela verdade do BASTÃO (por NF).
//
// Caio 2026-06-24 (desenho final): o Bastão faz full-refresh a cada rodada do RPA
// e RETÉM qualquer NF pendente com a oc atual; só larga a NF quando ela FINALIZA
// (1/30/32). Então, em vez de inferir saída por "sumiu do pull filtrado" + SSW
// (caro/frágil), este edge consulta o Bastão POR NF pras NFs dos cards que estão
// na aba e decide barato:
//   oc ∈ {6,9,16} → fica  |  oc ∉ {6,9,16} → sai roteado  |  ausente → RESOLVIDO.
//
// GATE DE FRESCOR INVIOLÁVEL: só age se o Bastão atualizou neste ciclo
// (max(updated_at) recente). Bastão velho/down → NÃO faz nada (senão "ausente"
// seria dado velho, não finalização). SSW não é usado aqui (fica pro conflito de
// oc lançada pelo Cockpit + pré-checagem do agente, PART 2).
//
// Gated por feature_flags.extravios_cockpit_enabled. Cron + invocação manual.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createBastaoClient,
  readBastaoEnvFromProcess,
} from "../_shared/bastao-client.ts";
import {
  type CardExtravioParaReconciliar,
  reconciliarExtraviosViaBastao,
} from "../_shared/reconciliar-extravios-bastao.ts";
import { normalizeNf } from "../_shared/extravio-enrichment.ts";

const FLAG_KEY = "extravios_cockpit_enabled";
const MAX_CARDS = 500; // por invocação (Bastão é barato; cap de segurança)
const LANCAMENTO_RECENTE_MIN = 60; // skip card com lançamento do Cockpit < 60min

Deno.serve(async (req) => {
  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResp({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Gate: feature flag.
  const { data: flag } = await supabase
    .from("feature_flags").select("enabled").eq("key", FLAG_KEY).maybeSingle();
  if (!(flag as { enabled?: boolean } | null)?.enabled) {
    return jsonResp({ ok: true, skipped: "flag_off" }, 200);
  }

  const body = await req.json().catch(() => ({}));
  // Gate de frescor = DETECTOR DE STALL (RPA vivo?), não exigência de dado novíssimo.
  // O RPA do Bastão faz full-refresh ~a cada 30min, então o limiar é ~1,5x a
  // cadência: > 45min sem refresh = RPA travado → não age. Tunável via env.
  const freshMin = Number.isFinite(body?.fresh_min)
    ? Number(body.fresh_min)
    : Number(Deno.env.get("EXTRAVIOS_BASTAO_FRESH_MIN") ?? "45");

  // ── GATE DE FRESCOR ────────────────────────────────────────────────────────
  // GARANTE que o Bastão atualizou neste ciclo. Sem isso, "NF ausente" pode ser
  // dado velho (RPA parado) e NÃO finalização → jamais RESOLVER por ausência.
  const bastao = createBastaoClient({ env: readBastaoEnvFromProcess(Deno.env.toObject()) });
  let maxUpdatedAt: string | null = null;
  try {
    maxUpdatedAt = await bastao.fetchBastaoMaxUpdatedAt();
  } catch (e) {
    return jsonResp({ ok: false, error: `frescor Bastão falhou: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
  const ageMin = maxUpdatedAt ? (Date.now() - new Date(maxUpdatedAt).getTime()) / 60_000 : Infinity;
  const bastaoFresco = Number.isFinite(ageMin) && ageMin <= freshMin;
  if (!bastaoFresco) {
    // Bastão velho/down → não mexe em NADA neste ciclo (espera atualizar).
    return jsonResp({
      ok: true, skipped: "bastao_stale", max_updated_at: maxUpdatedAt,
      age_min: Number.isFinite(ageMin) ? Math.round(ageMin) : null, fresh_min: freshMin,
    }, 200);
  }

  // Cards na aba EXTRAVIOS. Skip os com lançamento do Cockpit recente (a máquina
  // de ACAO_EXECUTADA/confirmação cuida deles; não competir com lançamento fresco).
  const cutoffLancamento = new Date(startedAt - LANCAMENTO_RECENTE_MIN * 60_000).toISOString();
  const { data: rows, error: selErr } = await supabase
    .from("cards")
    .select("id, nf, ctrc, cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia, agent_state, acao_executada_em")
    .eq("state", "EXTRAVIO_MONITORADO")
    .or(`acao_executada_em.is.null,acao_executada_em.lt.${cutoffLancamento}`)
    // PART 2 (Caio 2026-06-24): pula cards que o agente D+4 flaggou 'nao_rodou'
    // (achou oc pós-extravio no SSW). Ficam parados na coluna AUTÔNOMO NÃO RODOU
    // pro operador verificar/reportar — o reconciliador NÃO auto-move.
    .or("agente_extravio_status.is.null,agente_extravio_status.neq.nao_rodou")
    .order("bastao_synced_at", { ascending: true, nullsFirst: true })
    .limit(MAX_CARDS);
  if (selErr) return jsonResp({ ok: false, error: `SELECT cards: ${selErr.message}` }, 500);

  const cards = (rows ?? []) as Array<CardExtravioParaReconciliar & { acao_executada_em: string | null }>;
  if (cards.length === 0) {
    return jsonResp({ ok: true, max_updated_at: maxUpdatedAt, processados: 0, nota: "nenhum card na aba", duration_ms: Date.now() - startedAt }, 200);
  }

  // 1 query batch no Bastão por NF (não pelo filtro de ocorrência).
  const nfs = cards.map((c) => normalizeNf(c.nf)).filter((x): x is string => !!x);
  const pendencias = await bastao.fetchPendenciasByNfs(nfs);
  const pendenciaByNf = new Map<string, typeof pendencias[number]>();
  for (const p of pendencias) {
    const k = normalizeNf(p.nf);
    if (k && !pendenciaByNf.has(k)) pendenciaByNf.set(k, p);
  }

  const resultado = await reconciliarExtraviosViaBastao(supabase, cards, pendenciaByNf, {
    bastaoConfirmadoFresco: true,
    actorId: "sync-extravios-bastao",
  });

  try { await supabase.rpc("registrar_sync_extravios_concluido"); } catch { /* best-effort */ }

  return jsonResp({
    ok: true,
    max_updated_at: maxUpdatedAt,
    bastao_age_min: Math.round(ageMin),
    candidatos: cards.length,
    pendencias_no_bastao: pendencias.length,
    processados: resultado.processados,
    mantidos: resultado.mantidos,
    movidos: resultado.movidos,
    sem_acao: resultado.sem_acao,
    erros: resultado.erros,
    relatorio: resultado.relatorio,
    duration_ms: Date.now() - startedAt,
  }, 200);
});

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
