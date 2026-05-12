// =============================================================================
// puxar-historico-ssw-card — Larissa clica "TRAZER HISTÓRICO SSW" no card.
// Backend loga no SSW interno (opção 101), busca a NF, lista todas ocorrências
// históricas e grava em cards.historico_ssw + cards.historico_ssw_atualizado_em.
//
// Input:  { card_id }
// Output: { ok, total, ultima_oc, atualizado_em, ocorrencias, timings_ms }
//
// Caio 2026-05-12: feature útil pra inspeção rápida do histórico SSW direto
// no Cockpit, sem precisar abrir o SSW manualmente. Útil pra:
//   - Conferir histórico antes de aprovar ação
//   - Casos RPS (sem chave CT-e) onde Larissa precisa decidir manual
//   - Auditoria pós-execução (oc lançada bateu com o que esperava)
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buscarNFInterno,
  listarOcorrenciasNF,
  obterSessao,
  readSswInternalEnv,
} from "../_shared/ssw-internal-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ ok: false, error: "POST esperado" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "SUPABASE env ausente" }, 500);

  let body: { card_id?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: "JSON inválido" }, 400); }
  if (!body.card_id) return json({ ok: false, error: "card_id obrigatório" }, 400);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: card, error: cardErr } = await supabase
    .from("cards")
    .select("id, nf")
    .eq("id", body.card_id)
    .maybeSingle();
  if (cardErr) return json({ ok: false, error: `SELECT card: ${cardErr.message}` }, 500);
  if (!card?.nf) return json({ ok: false, error: "card_id sem NF" }, 404);

  const start = Date.now();
  const timings: Record<string, number> = {};

  try {
    const env = readSswInternalEnv(Deno.env.toObject());

    const t0 = Date.now();
    const sessao = await obterSessao(env);
    timings.login_ms = Date.now() - t0;

    const t1 = Date.now();
    const detalhe = await buscarNFInterno(sessao, card.nf as string);
    timings.busca_nf_ms = Date.now() - t1;

    const t2 = Date.now();
    const ocs = await listarOcorrenciasNF(sessao, detalhe);
    timings.listar_ocs_ms = Date.now() - t2;

    // Estrutura limpa pra renderizar no front
    const ocorrenciasNormalizadas = ocs.map((o) => ({
      codigo: o.codigo,
      descricao: o.descricao,
      instrucao: o.instrucao,
      data: o.data,
      filial: o.filial,
      usuario: o.usuario,
      tem_foto: o.fotos.length > 0,
    }));

    const atualizadoEm = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("cards")
      .update({
        historico_ssw: ocorrenciasNormalizadas,
        historico_ssw_atualizado_em: atualizadoEm,
      })
      .eq("id", card.id);
    if (upErr) return json({ ok: false, error: `UPDATE card: ${upErr.message}` }, 500);

    await supabase.from("card_events").insert({
      card_id: card.id,
      event_type: "HistoricoSswPuxado",
      actor_type: "system",
      actor_id: "puxar-historico-ssw-card",
      payload: {
        nf: card.nf,
        total_ocorrencias: ocorrenciasNormalizadas.length,
        timings_ms: timings,
      },
    });

    return json({
      ok: true,
      card_id: card.id,
      nf: card.nf,
      total: ocorrenciasNormalizadas.length,
      ultima_oc: ocorrenciasNormalizadas[0] ?? null,
      atualizado_em: atualizadoEm,
      ocorrencias: ocorrenciasNormalizadas,
      timings_ms: timings,
      total_ms: Date.now() - start,
    }, 200);
  } catch (err) {
    return json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      timings_ms: timings,
    }, 502);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
