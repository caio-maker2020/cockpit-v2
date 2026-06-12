// =============================================================================
// webhook-ssw-ocorrencias — receptor do webservice SSW2181
//
// ⚠️ ISOLAMENTO ESTRITO ⚠️ — Caio 2026-05-22:
//   1. NUNCA cria card sem aprovação manual do Caio. Mesmo NFs em whitelist
//      só ficam marcadas "aguardando_decisao_caio". Não toca em cards/todos/
//      card_events.
//   2. Kill switch: env WEBHOOK_SSW_KILL_SWITCH=true → responde 200 OK e
//      retorna SEM fazer nada. Útil pra desligar sem deploy.
//   3. Isolamento total: tabelas próprias (webhook_ssw_*), sem side-effects
//      em tabelas da plataforma (cards/todos/card_events).
//   4. Exclusão rápida: DROP TABLE webhook_ssw_eventos + webhook_ssw_test_nfs
//      + delete edge function. Tudo apagado sem impacto.
//
// SSW Sistemas envia POST com ocorrências em tempo real
// (https://ssw.inf.br/ajuda/webserviceOcorrencias.html).
//
// Auth (provisória, ajustar quando SSW confirmar):
//   Header X-SSW-Secret == env WEBHOOK_SSW_SECRET
//   Se WEBHOOK_SSW_SECRET vazio → aceita qualquer caller (só pra teste local).
//
// Resposta: shape exigido pela doc SSW (JSON array com retorno.protocolo).
//
// Idempotência: protocolo derivado de SHA(NF + oc + timestamp).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  extrairPayloadSsw,
  gerarProtocolo,
} from "../_shared/parser-ssw-webhook.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ssw-secret, X-SSW-Secret",
};

// Lista de códigos de ocorrência que viram card (alinhada com bastao-rules.ts
// OCORRENCIAS_DE_RELACIONAMENTO). Caio 2026-05-22: mantida inline aqui pra
// evitar import circular durante a fase de teste. Se divergir do bastão-rules
// é bug — reconciliar quando webhook for fonte primária.
const OC_RELACIONAMENTO = new Set([
  10, 11, 13, 19, 20, 21, 26, 33, 35, 41, 44, 49, 54, 55, 56,
]);

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function respostaSsw(
  codigo: number,
  descricao: string,
  protocolo: string,
  numeroNFe?: string | number,
  dataHora?: string,
): Response {
  // Shape exato exigido pela doc SSW: array de { retorno: {...} }
  return jsonResp([
    {
      retorno: {
        codigo,
        descricao,
        numeroNFe: numeroNFe ?? null,
        dataHora: dataHora ?? new Date().toISOString().replace("T", " ").slice(0, 19),
        protocolo,
      },
    },
  ], codigo === 200 ? 200 : codigo);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return respostaSsw(405, "Use POST", "");
  }

  const env = Deno.env.toObject();

  // 🛑 KILL SWITCH — Caio pode desativar tudo sem deploy:
  //   supabase secrets set WEBHOOK_SSW_KILL_SWITCH=true
  // SSW continua recebendo 200 OK (não retentando), mas edge NÃO faz nada:
  //   - Não loga em webhook_ssw_eventos
  //   - Não consulta whitelist
  //   - Não toca em cards/todos/card_events
  if (env["WEBHOOK_SSW_KILL_SWITCH"] === "true") {
    return respostaSsw(
      200,
      "WEBHOOK DESATIVADO (kill switch)",
      `desativado-${Date.now()}`,
    );
  }

  // Auth — aceita 2 métodos (qualquer um basta):
  //   1. Basic Auth: Authorization: Basic <base64(user:pass)>
  //      env WEBHOOK_SSW_USER + WEBHOOK_SSW_PASS
  //   2. Header secret: X-SSW-Secret: <env WEBHOOK_SSW_SECRET>
  //
  // SSW escolhe qual usar. Se NENHUMA env configurada, aceita anônimo (só
  // local/staging — em prod deixar pelo menos uma definida).
  const userEsperado = env["WEBHOOK_SSW_USER"];
  const passEsperado = env["WEBHOOK_SSW_PASS"];
  const secretEsperado = env["WEBHOOK_SSW_SECRET"];
  const algumaAuthConfigurada = !!(userEsperado && passEsperado) || !!secretEsperado;

  if (algumaAuthConfigurada) {
    const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";
    const sswSecretHeader =
      req.headers.get("x-ssw-secret") ?? req.headers.get("X-SSW-Secret") ?? "";

    let autorizado = false;

    // Tenta Basic Auth
    if (userEsperado && passEsperado && authHeader.toLowerCase().startsWith("basic ")) {
      try {
        const decoded = atob(authHeader.slice(6).trim());
        const idx = decoded.indexOf(":");
        if (idx > 0) {
          const u = decoded.slice(0, idx);
          const p = decoded.slice(idx + 1);
          if (u === userEsperado && p === passEsperado) autorizado = true;
        }
      } catch { /* base64 inválido, segue tentando outras vias */ }
    }

    // Tenta header secret
    if (!autorizado && secretEsperado && sswSecretHeader === secretEsperado) {
      autorizado = true;
    }

    if (!autorizado) {
      console.warn(`[webhook-ssw] auth inválida — basic_present=${authHeader.toLowerCase().startsWith("basic ")} secret_present=${!!sswSecretHeader}`);
      return respostaSsw(401, "Unauthorized — Basic Auth ou X-SSW-Secret ausente/inválido", "");
    }
  }

  // Lê body
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (e) {
    return respostaSsw(400, `JSON inválido: ${e instanceof Error ? e.message : String(e)}`, "");
  }

  // Tolera array ou objeto único (doc SSW mostra objeto, mas alguns clientes
  // empacotam em array)
  const items: unknown[] = Array.isArray(raw) ? raw : [raw];
  if (items.length === 0) {
    return respostaSsw(400, "Payload vazio", "");
  }

  // Por enquanto processa SÓ o primeiro item (caso bath, processa o 1º e loga
  // os demais — quando confirmarmos com SSW que vem batch, expandimos)
  const primeiro = items[0];
  const extracao = extrairPayloadSsw(primeiro);

  if (!extracao.ok) {
    console.warn(`[webhook-ssw] payload malformado: ${extracao.motivo}`);
    return respostaSsw(400, `Payload inválido: ${extracao.motivo}`, "");
  }

  const supabase = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const protocolo = await gerarProtocolo(extracao);
  const numeroNFe = extracao.nf;

  // Idempotência: tenta INSERT, ON CONFLICT no protocolo retorna evento existente
  // (sem criar duplicata). SSW reenvio → mesmo protocolo → 200 OK silencioso.
  const { data: existente } = await supabase
    .from("webhook_ssw_eventos")
    .select("id, processado, card_acao")
    .eq("protocolo", protocolo)
    .maybeSingle();

  if (existente) {
    return respostaSsw(
      200,
      "OCORRENCIA JA PROCESSADA (idempotência)",
      protocolo,
      numeroNFe,
    );
  }

  // Decide se NF está na whitelist (fase de teste)
  const { data: emWhitelist } = await supabase
    .from("webhook_ssw_test_nfs")
    .select("nf")
    .eq("nf", extracao.nf)
    .eq("ativo", true)
    .maybeSingle();
  const naWhitelist = !!emWhitelist;

  // INSERT log inicial (independente de processar ou não)
  const { data: evento, error: insErr } = await supabase
    .from("webhook_ssw_eventos")
    .insert({
      protocolo,
      cnpj_transportadora: extracao.cnpjTransportadora,
      cnpj_pagador: extracao.cnpjPagador,
      nf: extracao.nf,
      ctrc: extracao.ctrc,
      codigo_ocorrencia: extracao.codigoOc,
      descricao_ocorrencia: extracao.descricaoOc,
      data_hora_evento: extracao.dataEvento.toISOString(),
      raw_payload: extracao.raw,
      processado: false,
      na_whitelist: naWhitelist,
    })
    .select("id")
    .single();

  if (insErr) {
    console.error(`[webhook-ssw] INSERT webhook_ssw_eventos: ${insErr.message}`);
    return respostaSsw(500, `Erro persistência: ${insErr.message}`, protocolo, numeroNFe);
  }

  // Decide ação:
  //  - Fora whitelist → ignora (responde 200 OK pra SSW não retentar)
  //  - oc não-relacionamento → ignora
  //  - Card já existe pra NF → ignora
  //  - Caso contrário → cria card (TODO: implementar criação real após
  //    confirmar payload com SSW. Por enquanto registra "pronto pra criar")
  let cardAcao = "ignorado_whitelist";
  let cardId: string | null = null;
  let erro: string | null = null;

  if (naWhitelist) {
    if (!OC_RELACIONAMENTO.has(extracao.codigoOc)) {
      cardAcao = "oc_nao_relacionamento";
    } else {
      // Lookup card existente por NF (memory feedback_lookup_inclui_terminal_states)
      const { data: cardExistente } = await supabase
        .from("cards")
        .select("id, state")
        .eq("nf", extracao.nf)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cardExistente) {
        cardAcao = "card_existe";
        cardId = (cardExistente as { id: string }).id;
      } else {
        // ⚠️ NUNCA cria card automaticamente. Caio aprova manualmente NF a NF
        // via SQL antes de qualquer criação real (Fase 2). Por enquanto
        // só registra evento auditável — ZERO side-effect em cards/todos.
        cardAcao = "aguardando_decisao_caio";
      }
    }
  }

  await supabase
    .from("webhook_ssw_eventos")
    .update({
      processado: true,
      card_acao: cardAcao,
      card_id: cardId,
      erro,
      processado_em: new Date().toISOString(),
    })
    .eq("id", (evento as { id: string }).id);

  // Sempre responde 200 OK — manter SSW feliz. Erros tratados internamente
  // via dashboard/log de webhook_ssw_eventos.
  return respostaSsw(
    200,
    `OCORRENCIA RECEBIDA (acao=${cardAcao})`,
    protocolo,
    numeroNFe,
    extracao.dataEvento.toISOString().replace("T", " ").slice(0, 19),
  );
});
