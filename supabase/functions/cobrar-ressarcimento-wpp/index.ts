// =============================================================================
// cobrar-ressarcimento-wpp — botão "📱 COBRAR RESSARCIMENTO" do banner
// agente oc=49 Caso 1c (extravio sem qtd identificada).
// Data: 2026-05-29
//
// Fluxo:
//   1. Auth: Bearer da operadora (auth.uid via supabaseUser)
//   2. SELECT card via RLS (operadora precisa enxergar) — pega nf,
//      responsavel_relacionamento pra resolver instance Evolution
//   3. SELECT contatos_escalonamento WHERE cargo='time_ressarcimento' ativo
//   4. Pra cada contato: dispara mensagem via send-whatsapp-message
//   5. Update cards.aviso_alteracao_oc.cobrada_no_wpp=true + cobrada_em
//   6. INSERT card_events AcionamentoRessarcimentoWpp
//   7. Retorna { ok, contatos_enviados, contatos_falha }
//
// Idempotência: se card já está com cobrada_no_wpp=true, devolve idempotent
// (não dispara de novo) com obs no retorno — operador clica "Cobrar de novo"
// se quiser forçar (passa force=true).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResp({ ok: false, error: "POST esperado" }, 405);

  const env = Deno.env.toObject();
  const authHeader = req.headers.get("Authorization") ?? "";

  // Cliente com auth do operador (pra SELECT card via RLS)
  const supabaseUser = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_ANON_KEY"]!,
    { global: { headers: { Authorization: authHeader } } },
  );

  // Cliente service_role pra UPDATEs e SELECT em contatos (que tem RLS gestor)
  const supabaseSvc = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const body = await req.json().catch(() => ({})) as {
    card_id?: string;
    force?: boolean;
  };
  if (!body.card_id) return jsonResp({ ok: false, error: "card_id obrigatório" }, 400);

  // 1. SELECT card via RLS — operadora precisa ter acesso
  const { data: card, error: cardErr } = await supabaseUser
    .from("cards")
    .select("id, nf, responsavel_relacionamento, aviso_alteracao_oc, cod_ultima_ocorrencia, agent_state")
    .eq("id", body.card_id)
    .maybeSingle();
  if (cardErr) return jsonResp({ ok: false, error: `SELECT card: ${cardErr.message}` }, 500);
  if (!card) return jsonResp({ ok: false, error: "card não encontrado ou sem acesso" }, 404);

  const nf = (card as { nf?: string | null }).nf;
  if (!nf) return jsonResp({ ok: false, error: "card sem NF" }, 400);

  const agentState = ((card as { agent_state?: Record<string, unknown> | null }).agent_state ?? {}) as Record<string, unknown>;
  const cnpjPagador = (agentState["cnpj_pagador"] as string | undefined) ?? null;
  if (!cnpjPagador) {
    return jsonResp({
      ok: false,
      error: "card sem cnpj_pagador em agent_state — não dá pra rotear pro analista responsável. Avise o Caio.",
    }, 400);
  }

  const avisoExistente = ((card as { aviso_alteracao_oc?: Record<string, unknown> }).aviso_alteracao_oc ?? {}) as Record<string, unknown>;

  // Idempotência: já cobrada e não pediu force?
  if (avisoExistente["cobrada_no_wpp"] === true && body.force !== true) {
    return jsonResp({
      ok: true,
      idempotent: true,
      cobrada_em: avisoExistente["cobrada_em"] ?? null,
      message: "Card já marcado como COBRADA NO WPP. Use force=true pra cobrar novamente.",
    }, 200);
  }

  // 2. SELECT contato time_ressarcimento ROTEADO POR CNPJ PAGADOR.
  // Caio 2026-06-01 (mig 185): contatos_escalonamento.cnpjs_pagador text[] —
  // analista específica (Thiago/Mariana/Luciana) cobre lista de CNPJs.
  // Lookup: tenta específico primeiro (cnpjs_pagador && ARRAY[cnpj]); se nada,
  // fallback pro global (cnpjs_pagador IS NULL). Dispara pra UM contato só.
  const { data: especifico, error: espErr } = await supabaseSvc
    .from("contatos_escalonamento")
    .select("nome, telefone")
    .eq("cargo", "time_ressarcimento")
    .eq("ativo", true)
    .not("telefone", "is", null)
    .overlaps("cnpjs_pagador", [cnpjPagador])
    .limit(1);
  if (espErr) return jsonResp({ ok: false, error: `SELECT contato especifico: ${espErr.message}` }, 500);

  let contato: { nome: string; telefone: string } | null =
    (especifico && especifico[0]) ? (especifico[0] as { nome: string; telefone: string }) : null;
  let viaFallbackGlobal = false;

  if (!contato) {
    const { data: global, error: globalErr } = await supabaseSvc
      .from("contatos_escalonamento")
      .select("nome, telefone")
      .eq("cargo", "time_ressarcimento")
      .eq("ativo", true)
      .not("telefone", "is", null)
      .is("cnpjs_pagador", null)
      .limit(1);
    if (globalErr) return jsonResp({ ok: false, error: `SELECT contato global: ${globalErr.message}` }, 500);
    contato = (global && global[0]) ? (global[0] as { nome: string; telefone: string }) : null;
    viaFallbackGlobal = !!contato;
  }

  if (!contato) {
    return jsonResp({
      ok: false,
      error: `Nenhum analista de ressarcimento cobre o CNPJ ${cnpjPagador}, e não há contato global (fallback) cadastrado. Cadastre em Configurações > Contatos de escalonamento > Time Ressarcimento.`,
    }, 400);
  }

  // 3. Resolve operador_email do responsável pra escolher instance Evolution
  const respNome = (card as { responsavel_relacionamento?: string | null }).responsavel_relacionamento;
  let operadorEmail: string | null = null;
  if (respNome) {
    const { data: op } = await supabaseSvc
      .from("operadores")
      .select("email")
      .eq("nome", respNome)
      .maybeSingle();
    operadorEmail = (op as { email?: string } | null)?.email ?? null;
  }

  // 4. Dispara WPP pro analista escolhido (1 mensagem só, não broadcast)
  const primeiroNome = (contato.nome ?? "").split(/\s+/)[0] ?? "Equipe";
  const mensagem =
    `${primeiroNome}, não consegui pelo SSW identificar quantos volumes ` +
    `estão extraviados na NF ${nf}, poderia me informar?`;
  const enviados: Array<{ nome: string; telefone: string }> = [];
  const falhas: Array<{ nome: string; telefone: string; erro: string }> = [];
  try {
    const res = await fetch(`${env["SUPABASE_URL"]}/functions/v1/send-whatsapp-message`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
        apikey: env["SUPABASE_SERVICE_ROLE_KEY"]!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operador_email: operadorEmail,
        telefone: contato.telefone,
        mensagem,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      enviados.push({ nome: contato.nome, telefone: contato.telefone });
    } else {
      const errText = await res.text();
      falhas.push({ nome: contato.nome, telefone: contato.telefone, erro: `${res.status} ${errText.slice(0, 200)}` });
    }
  } catch (err) {
    falhas.push({
      nome: contato.nome,
      telefone: contato.telefone,
      erro: err instanceof Error ? err.message : String(err),
    });
  }

  if (enviados.length === 0) {
    return jsonResp({
      ok: false,
      error: `Falha ao enviar WPP pra ${contato.nome} (${contato.telefone}). Verifique Evolution + telefone.`,
      falhas,
    }, 502);
  }

  // 5. UPDATE aviso_alteracao_oc — marca cobrada_no_wpp=true (service_role)
  const cobradaEm = new Date().toISOString();
  const avisoNovo = {
    ...avisoExistente,
    cobrada_no_wpp: true,
    cobrada_em: cobradaEm,
  };
  await supabaseSvc
    .from("cards")
    .update({ aviso_alteracao_oc: avisoNovo })
    .eq("id", body.card_id);

  // 6. card_event de auditoria
  await supabaseSvc.from("card_events").insert({
    card_id: body.card_id,
    event_type: "AcionamentoRessarcimentoWpp",
    actor_type: "operator",
    actor_id: "cobrar-ressarcimento-wpp",
    payload: {
      nf,
      cnpj_pagador: cnpjPagador,
      cod_ultima_ocorrencia: (card as { cod_ultima_ocorrencia?: number | null }).cod_ultima_ocorrencia ?? null,
      analista: contato.nome,
      via_fallback_global: viaFallbackGlobal,
      enviados,
      falhas,
      cobrada_em: cobradaEm,
      force: body.force === true,
    },
  });

  return jsonResp({
    ok: true,
    card_id: body.card_id,
    nf,
    cnpj_pagador: cnpjPagador,
    analista: contato.nome,
    via_fallback_global: viaFallbackGlobal,
    cobrada_em: cobradaEm,
    enviados,
    falhas,
    total_enviados: enviados.length,
    total_falhas: falhas.length,
  }, 200);
});

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
