// =============================================================================
// revalidar-evidencia-card — Reroda a verificação de evidência pra um card
// específico depois de cadastros tardios (ex.: senha tracking SSW adicionada
// agora). Útil quando o ciclo natural (vinculador/sync-bastao) já passou e
// deixou `evidencia_status='scrape_indisponivel'` por falta de credenciais.
//
// Endpoint: POST { card_id, codigo_oc? }
//  - Se `codigo_oc` não vier: usa cards.cod_ultima_ocorrencia; se não estiver
//    em OCS_PRECISAM_EVIDENCIA (10/11/35), busca o último card_event
//    EvidenciaSugestaoIA pra recuperar a oc histórica que precisava.
//
// Resposta: { ok, card_id, nf, codigo_oc_usada, resultado, diagnostico }
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  montarDiagnostico,
  OCS_PRECISAM_EVIDENCIA,
  temEvidenciaParaOc,
} from "../_shared/verificar-evidencia.ts";

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

  let body: { card_id?: string; codigo_oc?: number };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON body inválido" }, 400);
  }
  if (!body.card_id) return json({ ok: false, error: "campo card_id obrigatório" }, 400);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: card, error: cardErr } = await supabase
    .from("cards")
    .select("id, nf, ctrc, cod_ultima_ocorrencia, agent_state")
    .eq("id", body.card_id)
    .maybeSingle();
  if (cardErr) return json({ ok: false, error: `SELECT card: ${cardErr.message}` }, 500);
  if (!card) return json({ ok: false, error: `card_id ${body.card_id} não encontrado` }, 404);

  const cnpjPagador = (card.agent_state as Record<string, unknown> | null)?.["cnpj_pagador"] as string | undefined;
  if (!card.nf || !cnpjPagador) {
    return json({ ok: false, error: "card sem nf/cnpj_pagador" }, 400);
  }

  let codigoOc: number | null = body.codigo_oc ?? (card.cod_ultima_ocorrencia as number | null);
  if (codigoOc == null || !OCS_PRECISAM_EVIDENCIA.has(codigoOc)) {
    // Tenta recuperar da última sugestão IA
    const { data: ev } = await supabase
      .from("card_events")
      .select("payload")
      .eq("card_id", card.id)
      .eq("event_type", "EvidenciaSugestaoIA")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const hist = (ev?.payload as Record<string, unknown> | null)?.["cod_ocorrencia"];
    if (typeof hist === "number") codigoOc = hist;
  }
  if (codigoOc == null) {
    return json({ ok: false, error: "Sem oc pra revalidar (atual fora do gate e sem histórico)" }, 400);
  }

  // Caio 2026-05-14 (NF 20761): propaga card.ctrc pra evitar falso negativo
  // em NFs com múltiplos CTRCs (reentrega/complementar).
  const ctrcCard = (card.ctrc as string | null | undefined) ?? null;
  const resultado = await temEvidenciaParaOc(supabase, card.nf as string, cnpjPagador, codigoOc, ctrcCard);
  const diagnostico = montarDiagnostico(resultado, codigoOc);

  const { error: upErr } = await supabase
    .from("cards")
    .update({ evidencia_status: resultado.status, evidencia_diagnostico: diagnostico })
    .eq("id", card.id);
  if (upErr) return json({ ok: false, error: `UPDATE card: ${upErr.message}` }, 500);

  await supabase.from("card_events").insert({
    card_id: card.id,
    event_type: "EvidenciaRevalidadaManual",
    actor_type: "system",
    actor_id: "revalidar-evidencia-card",
    payload: { ...resultado, cod_ocorrencia: codigoOc, nf: card.nf, cnpj_pagador: cnpjPagador },
  });

  return json({
    ok: true,
    card_id: card.id,
    nf: card.nf,
    codigo_oc_usada: codigoOc,
    resultado,
    diagnostico,
  }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
