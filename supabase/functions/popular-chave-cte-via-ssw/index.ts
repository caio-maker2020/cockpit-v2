// =============================================================================
// popular-chave-cte-via-ssw — busca chave CT-e via SSW interno (listarCTRCsDaNF
// parseia XML embarcado do portal onde f11=chave) e popula nf_chave_cte.
//
// Caio 2026-06-05: fallback pra NFs com CTRC de transportadora externa
// (prefixo PON, TBH, etc) que o RPA OPC 455 do sócio nunca captura.
// Caso âncora: NF 59938 LARISSA INOVAMED CTRC PON000521-5.
//
// Input:  { card_id }
// Output: { ok, nf, ctrc, chave_cte, inserted }
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  listarCTRCsDaNF,
  loadSswInternalEnvForCard,
  obterSessao,
} from "../_shared/ssw-internal-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST esperado" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "SUPABASE env ausente" }, 500);

  const body = await req.json().catch(() => ({})) as { card_id?: string };
  if (!body.card_id) return json({ ok: false, error: "card_id obrigatório" }, 400);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: card, error: cardErr } = await supabase
    .from("cards")
    .select("id, nf, ctrc, agent_state")
    .eq("id", body.card_id)
    .maybeSingle();
  if (cardErr) return json({ ok: false, error: `SELECT card: ${cardErr.message}` }, 500);
  if (!card) return json({ ok: false, error: "card não encontrado" }, 404);

  const nf = card.nf as string;
  const ctrcEsperado = (card.ctrc as string | null)?.toUpperCase().trim() ?? null;
  if (!nf || !ctrcEsperado) return json({ ok: false, error: "card sem nf ou ctrc" }, 400);

  try {
    const env = await loadSswInternalEnvForCard(supabase, Deno.env.toObject(), card.id as string);
    const sessao = await obterSessao(env);
    const ctrcs = await listarCTRCsDaNF(sessao, nf);
    const match = ctrcs.find((c) => c.ctrc.toUpperCase().trim() === ctrcEsperado);

    if (!match) {
      return json({
        ok: false,
        error: `CTRC ${ctrcEsperado} não encontrado entre os ${ctrcs.length} retornados pela NF ${nf}`,
        ctrcs_disponiveis: ctrcs.map((c) => ({ ctrc: c.ctrc, tipo: c.tipo, cancelado: c.cancelado })),
      }, 404);
    }

    // Normaliza chave: só dígitos (remove espaços, hifens, etc)
    const chaveNormalizada = (match.chave_cte ?? "").replace(/\D/g, "");
    const chaveValida = chaveNormalizada.length === 44 || chaveNormalizada.length === 50;

    if (!chaveValida) {
      return json({
        ok: false,
        error: `CTRC ${ctrcEsperado} encontrado, mas chave_cte do XML inválida.`,
        debug: {
          chave_bruta: match.chave_cte,
          chave_normalizada: chaveNormalizada,
          length: chaveNormalizada.length,
          tipo: match.tipo,
          cancelado: match.cancelado,
          total_ctrcs: ctrcs.length,
          todos_ctrcs: ctrcs.map((c) => ({
            ctrc: c.ctrc,
            tipo: c.tipo,
            cancelado: c.cancelado,
            chave_len: c.chave_cte?.replace(/\D/g, "").length ?? 0,
            chave_preview: c.chave_cte?.slice(0, 12) ?? null,
          })),
        },
      }, 422);
    }

    const cnpjPagador = (card.agent_state as Record<string, unknown> | null)?.cnpj_pagador as string | undefined;

    // data_emissao do SSW vem como "DD/MM/AA" (ex: "27/03/26"). Converte pra ISO.
    let dataEmissaoIso: string | null = null;
    if (match.data_emissao) {
      const m = match.data_emissao.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
      if (m) {
        const ano = m[3].length === 2 ? `20${m[3]}` : m[3];
        dataEmissaoIso = `${ano}-${m[2]}-${m[1]}`;
      }
    }

    const { error: insErr } = await supabase
      .from("nf_chave_cte")
      .upsert({
        chave_cte: chaveNormalizada,
        nf,
        cnpj_pagador: cnpjPagador ?? "",
        ctrc: match.ctrc,
        data_emissao: dataEmissaoIso,
        tipo_documento: match.tipo || null,
        import_session: "2026-06-05T13-47-41Z",
        imported_via: "popular_via_ssw_interno",
      }, { onConflict: "chave_cte" });
    if (insErr) return json({ ok: false, error: `UPSERT nf_chave_cte: ${insErr.message}` }, 500);

    // Propaga pro agent_state
    await supabase
      .from("cards")
      .update({
        agent_state: { ...(card.agent_state as Record<string, unknown> ?? {}), chave_cte: chaveNormalizada },
      })
      .eq("id", card.id);

    await supabase.from("card_events").insert({
      card_id: card.id,
      event_type: "ChaveCtePopuladaViaSswInterno",
      actor_type: "system",
      actor_id: "popular-chave-cte-via-ssw",
      payload: { nf, ctrc: match.ctrc, chave_cte: match.chave_cte, tipo: match.tipo },
    });

    return json({
      ok: true,
      nf,
      ctrc: match.ctrc,
      chave_cte: match.chave_cte,
      tipo: match.tipo,
      data_emissao: match.data_emissao,
      cancelado: match.cancelado,
    }, 200);
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
