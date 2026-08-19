// =============================================================================
// enviar-retificacao-evidencia — retroativo pra cards cujo email saiu sem o
// {link_evidencia} (bug pré-fix 2026-05-29 do executor — omitia link quando oc
// estava em ocs_bloqueadas_tracking). Envia reply na MESMA thread do email
// original com texto de retificação + link de evidência da oc atual do card.
//
// Input (service_role):
//   POST { card_id: string, texto_prefixo?: string }
//
// Comportamento:
//   1. Lê última RespostaEnviada do card (destinatário, subject, thread_id,
//      operador).
//   2. Gera token novo em tokens_evidencia (oc = cod_ultima_ocorrencia).
//   3. Compõe corpo: <prefixo> + link + assinatura do operador.
//   4. Envia via Gmail API como reply na mesma thread (threadId).
//   5. INSERT em card_events `RetificacaoEvidenciaEnviada` + cards_emails_outbound.
//
// Default texto_prefixo: "Boa tarde,\n\nRetificando o email anterior, segue
// link da evidência:"
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sendGmailMessage } from "../_shared/gmail-sender.ts";
import { garantirPrefixoReply } from "../_shared/email-threading.ts";
import { novaExpiracaoTokenEvidencia } from "../_shared/token-evidencia.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_PREFIXO = "Boa tarde,\n\nRetificando o email anterior, segue link da evidência:";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResp({ ok: false, error: "POST esperado" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const body = await req.json().catch(() => ({})) as {
    card_id?: string;
    texto_prefixo?: string;
    /** Override do código de oc que o token vai apontar. Sem ele, usa
     *  card.cod_ultima_ocorrencia. Útil quando a oc atual é apenas marcador
     *  Cockpit (ex: oc=54 lançada pelo executor) e o link tem que apontar
     *  pra evidência da oc operacional anterior (ex: oc=49). */
    cod_ocorrencia?: number;
  };
  if (!body.card_id) return jsonResp({ ok: false, error: "card_id obrigatório" }, 400);

  // 1. Card
  const { data: card, error: cardErr } = await supabase
    .from("cards")
    .select("id, nf, ctrc, cod_ultima_ocorrencia, agent_state, assigned_operator_id, operadores:assigned_operator_id(id, nome, email)")
    .eq("id", body.card_id)
    .maybeSingle();
  if (cardErr || !card) return jsonResp({ ok: false, error: `card não encontrado: ${cardErr?.message ?? "null"}` }, 404);

  const nf = (card as Record<string, unknown>)["nf"] as string | null;
  const codOcCard = (card as Record<string, unknown>)["cod_ultima_ocorrencia"] as number | null;
  // Caio 2026-05-29: aceita override pra apontar pra evidência da oc
  // operacional (ex: 49) quando a oc atual do card é só marcador Cockpit
  // (ex: 54 AGUARDANDO RETORNO CLIENTE).
  const codOc = (typeof body.cod_ocorrencia === "number" && Number.isInteger(body.cod_ocorrencia))
    ? body.cod_ocorrencia
    : codOcCard;
  const agentState = ((card as Record<string, unknown>)["agent_state"] ?? {}) as Record<string, unknown>;
  const cnpjPagador = (agentState["cnpj_pagador"] as string | null) ?? null;
  const operadorId = (card as Record<string, unknown>)["assigned_operator_id"] as string | null;
  const operadorNome = ((card as { operadores?: { nome?: string } | null }).operadores?.nome) ?? "Sal Express";

  if (!nf) return jsonResp({ ok: false, error: "card sem nf" }, 400);
  if (codOc == null) return jsonResp({ ok: false, error: "card sem cod_ultima_ocorrencia" }, 400);
  if (!cnpjPagador) return jsonResp({ ok: false, error: "card sem cnpj_pagador em agent_state" }, 400);
  if (!operadorId) return jsonResp({ ok: false, error: "card sem assigned_operator_id" }, 400);

  // 2. Última RespostaEnviada — destinatário, subject, thread
  const { data: ultimaResposta } = await supabase
    .from("card_events")
    .select("payload")
    .eq("card_id", body.card_id)
    .eq("event_type", "RespostaEnviada")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const payload = (ultimaResposta as { payload?: Record<string, unknown> } | null)?.payload;
  if (!payload) return jsonResp({ ok: false, error: "nenhuma RespostaEnviada anterior pra esse card" }, 400);

  const destinatario = payload["destinatario"] as string | null;
  const ccArr = Array.isArray(payload["cc"]) ? payload["cc"] as string[] : [];
  const subjectOriginal = (payload["subject"] as string | null) ?? `Mensagem Sal Express — NF ${nf}`;
  const threadId = (payload["gmail_thread_id"] as string | null) ?? null;
  if (!destinatario) return jsonResp({ ok: false, error: "RespostaEnviada sem destinatario" }, 400);

  // 3. Gera token de evidência
  const expiraEm = novaExpiracaoTokenEvidencia();
  const { data: tokenRow, error: tokenErr } = await supabase
    .from("tokens_evidencia")
    .insert({
      card_id: body.card_id,
      cnpj_pagador: cnpjPagador,
      nf,
      cod_ocorrencia: codOc,
      expira_em: expiraEm,
    })
    .select("id")
    .single();
  if (tokenErr || !tokenRow) return jsonResp({ ok: false, error: `INSERT token: ${tokenErr?.message ?? "null"}` }, 500);
  const tokenId = (tokenRow as { id: string }).id;
  const baseEvidencia = Deno.env.get("EVIDENCIA_BASE_URL") ?? "https://cockpit-r-evidencia.vercel.app";
  const linkEvidencia = `${baseEvidencia}/r?t=${tokenId}`;

  // 4. Compõe corpo
  const prefixo = body.texto_prefixo ?? DEFAULT_PREFIXO;
  const corpoTexto =
    `${prefixo}\n\n${linkEvidencia}\n\nAtenciosamente,\n${operadorNome}\nSal Express — Relacionamento`;

  // Subject reply: mantém prefixo existente (RES:/ENC:/…) ou prefixa "Re: "
  // — fonte única (fix Outlook NF 1597524, Caio 2026-08-18).
  const subjectReply = garantirPrefixoReply(subjectOriginal);

  // 5. Envia
  const sendRes = await sendGmailMessage({
    supabase,
    operadorId,
    destinatario,
    cc: ccArr.length > 0 ? ccArr : null,
    subject: subjectReply,
    texto: corpoTexto,
    fromName: operadorNome,
    threadId,
  });

  if (!sendRes.ok) {
    return jsonResp({ ok: false, error: `gmail send: ${sendRes.error}`, link_gerado: linkEvidencia }, 502);
  }

  // 6. Audit
  await supabase.from("card_events").insert({
    card_id: body.card_id,
    event_type: "RetificacaoEvidenciaEnviada",
    actor_type: "system",
    actor_id: "enviar-retificacao-evidencia",
    payload: {
      destinatario,
      cc: ccArr,
      subject: subjectReply,
      gmail_message_id: sendRes.messageId,
      gmail_thread_id: sendRes.threadId,
      link_evidencia: linkEvidencia,
      token_evidencia_id: tokenId,
      cod_ocorrencia: codOc,
      motivo: "Retificação do email anterior que saiu sem link (bug ocs_bloqueadas_tracking pré-fix 2026-05-29)",
    },
  });

  await supabase.from("cards_emails_outbound").insert({
    card_id: body.card_id,
    operadora_id: operadorId,
    gmail_message_id: sendRes.messageId,
    gmail_thread_id: sendRes.threadId,
    from_email: sendRes.from,
    to_email: destinatario,
    subject: subjectReply,
    corpo_renderizado: corpoTexto,
  }).then(() => {}, () => {});

  return jsonResp({
    ok: true,
    card_id: body.card_id,
    nf,
    cod_ocorrencia: codOc,
    destinatario,
    subject: subjectReply,
    gmail_message_id: sendRes.messageId,
    gmail_thread_id: sendRes.threadId,
    link_evidencia: linkEvidencia,
    token_evidencia_id: tokenId,
  }, 200);
});

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
