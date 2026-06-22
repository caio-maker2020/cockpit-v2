// =============================================================================
// responder-email-cliente — Larissa responde email do cliente direto pelo
// Cockpit. Envio via Gmail API com headers In-Reply-To/References pra manter
// thread no Gmail (cliente vê resposta na mesma conversa).
//
// Input: { card_id, texto, mensagem_origem_id? }
// Auth:  Bearer da operadora (auth.uid() → operadores → gmail_oauth_credentials)
//
// Fluxo:
//   1. Auth Larissa
//   2. Carrega card + última mensagem inbound (ou mensagem_origem_id se passado)
//   3. Carrega operador → Gmail credentials → access_token (refresh se preciso)
//   4. Compose RFC 2822: From=Larissa, To=remetente original (sem CC),
//      Subject="Re: ...", In-Reply-To=<msg-origem>, References=<cadeia>
//   5. POST gmail/users/me/messages/send
//   6. INSERT card_event "RespostaManualEnviadaPeloCockpit"
//   7. Retorna { ok, gmail_message_id, thread_id }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const env = Deno.env.toObject();

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ ok: false, error: "Authorization Bearer obrigatório" }, 401);
    }

    const supabaseUser = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_ANON_KEY"]!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userRes } = await supabaseUser.auth.getUser();
    const user = userRes?.user;
    if (!user) return json({ ok: false, error: "User não autenticado" }, 401);

    const supabaseSvc = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const body = await req.json().catch(() => ({}));
    const cardId: string | undefined = body.card_id;
    const texto: string | undefined = body.texto;
    const mensagemOrigemId: string | undefined = body.mensagem_origem_id;
    // cc opcional: array de emails extras pra copiar. Operadora seleciona via
    // multi-select dos contatos do cliente. Padrão idêntico ao composer oc=54:
    // 1 único envio Gmail com TO + Cc (nunca múltiplos emails separados).
    const ccBruto: string[] = Array.isArray(body.cc)
      ? (body.cc as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    // Caio 2026-05-06: anexos opcionais (UUIDs em email_anexos)
    const anexosIds: string[] = Array.isArray(body.anexos_ids)
      ? (body.anexos_ids as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];

    if (!cardId || !texto?.trim()) {
      return json({ ok: false, error: "card_id e texto obrigatórios" }, 400);
    }

    // 1. Operadora + Gmail credentials
    const { data: op } = await supabaseSvc
      .from("operadores")
      .select("id, nome, nome_email_outbound, gmail_oauth_credentials")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!op?.gmail_oauth_credentials) {
      return json({
        ok: false,
        error: "Operadora sem Gmail conectado. Conecte em Configurações > Email do Cockpit.",
      }, 400);
    }
    const creds = op.gmail_oauth_credentials as {
      refresh_token: string;
      email: string;
      access_token_cache?: string;
      access_token_expira_em?: string;
    };

    // 2. Carrega card + mensagem origem
    const { data: card } = await supabaseSvc
      .from("cards")
      .select("id, nf, empresa_cliente, cod_ultima_ocorrencia")
      .eq("id", cardId)
      .maybeSingle();
    if (!card) return json({ ok: false, error: "card não encontrado" }, 404);

    let msgQuery = supabaseSvc
      .from("messages_inbox")
      .select("id, remetente, conteudo, message_id_header, in_reply_to_header, references_header, raw_payload")
      .eq("card_id", cardId)
      .eq("canal", "email");

    if (mensagemOrigemId) {
      msgQuery = msgQuery.eq("id", mensagemOrigemId);
    } else {
      msgQuery = msgQuery.order("recebido_em", { ascending: false }).limit(1);
    }

    const { data: msgs } = await msgQuery;
    const origem = (msgs ?? [])[0] as Record<string, unknown> | undefined;
    if (!origem) {
      return json({
        ok: false,
        error: "Não achei mensagem inbound nesse card pra responder.",
      }, 404);
    }

    // 3. Refresh access_token se preciso
    const accessToken = await refreshAccessToken(supabaseSvc, op.id as string, creds, env);

    // 4. Extrai subject original do raw_payload.
    // Caio 2026-05-11 (NF 690480 MED CENTER): captura inbound migrou de Postmark
    // pro Gmail polling. Postmark grava "Subject" capitalizado; Gmail polling
    // grava "subject" lowercase. Sem fallback corretto, caia em "Sua mensagem"
    // e thread Gmail quebrava (subject novo == subject diferente da thread).
    const rawPayload = (origem["raw_payload"] ?? {}) as Record<string, unknown>;
    const subjectOrig =
      (rawPayload["subject"] as string | undefined) ??
      (rawPayload["Subject"] as string | undefined) ??
      "Sua mensagem";
    const subject = /^re:\s/i.test(subjectOrig) ? subjectOrig : `Re: ${subjectOrig}`;

    // Gmail thread_id da mensagem original — passar direto ao Gmail send API
    // garante que a resposta vai pra MESMA conversa (sem depender de heurística
    // por Subject/In-Reply-To no lado do Gmail). Caio 2026-05-11 (NF 690480).
    const gmailThreadIdOrigem =
      (rawPayload["gmail_thread_id"] as string | undefined) ?? null;

    // Caio 2026-06-17: o gmail_thread_id é específico da CAIXA Gmail que capturou
    // o inbound. Se o card foi reatribuído (reorg de operadores 2026-06-15:
    // CARLOS/DURAFA excluídos → ISA E KAROL/VICTOR), a thread fica na caixa do
    // operador ANTIGO. Mandar esse threadId a partir da caixa do operador ATUAL
    // faz o Gmail rejeitar (thread inexistente nessa caixa) → 500 "non-2xx".
    // Fix: só reusa o threadId se a caixa que capturou == a que envia. Senão
    // envia como thread nova na caixa atual — os headers In-Reply-To/References
    // (mantidos abaixo) garantem que o CLIENTE ainda veja como resposta.
    // Caso âncora: NF 5558833 fortbras, thread capturada em auto.pecas@ (CARLOS),
    // resposta tentada por sac@ (ISA E KAROL).
    const inboundOperadorId = (rawPayload["operador_id"] as string | undefined) ?? null;
    const mesmaCaixaGmail = inboundOperadorId == null || inboundOperadorId === (op.id as string);
    const threadIdParaEnvio = mesmaCaixaGmail ? gmailThreadIdOrigem : null;
    if (!mesmaCaixaGmail) {
      console.log(
        `[responder-email] card ${cardId}: thread ${gmailThreadIdOrigem} é da caixa do operador ${inboundOperadorId} (≠ remetente ${op.id}) — enviando como thread nova (reatribuição de operador).`,
      );
    }

    // To = remetente original (preserva thread Gmail via In-Reply-To).
    // Cc = lista opcional de contatos extras do cliente (multi-select da
    // operadora). Filtra duplicatas pra não copiar pra quem já está no TO.
    // Regra Caio 2026-05-05: 1 ÚNICO envio Gmail com TO+Cc, nunca múltiplos
    // emails separados (cliente entende como 'todos copiados na mesma msg').
    const to = origem["remetente"] as string;
    const toLower = (to ?? "").toLowerCase();
    // Caio 2026-05-27 (NF 647901 DURAFA): quando o front NÃO passa cc
    // explícito, deriva dos headers To+Cc da mensagem inbound. Cliente que
    // respondeu adicionando outros endereços em cópia (ex: transporte@isapa)
    // tem TODOS os participantes preservados na resposta seguinte.
    // Se o front PASSAR cc explícito (operador editou no composer), respeita
    // o que ele escolheu (pode ter desmarcado alguém).
    let ccLista: string[];
    if (ccBruto.length > 0) {
      ccLista = ccBruto
        .map((e) => e.trim())
        .filter((e) => e.length > 0 && e.toLowerCase() !== toLower);
    } else {
      // Deriva da mensagem inbound: headers To + Cc (extrai endereços de email)
      const operadorEmail = ((op as { email?: string | null }).email ?? "").toLowerCase();
      const headers = [
        (rawPayload["to"] as string | undefined) ?? "",
        (rawPayload["cc"] as string | undefined) ?? "",
      ].join(", ");
      // Extrai endereços <foo@bar> ou "foo@bar"
      const emailRegex = /[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
      const derivados = (headers.match(emailRegex) ?? [])
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e !== toLower && e !== operadorEmail);
      // Dedup preservando ordem
      const visto = new Set<string>();
      ccLista = derivados.filter((e) => {
        if (visto.has(e)) return false;
        visto.add(e);
        return true;
      });
    }

    // Headers de thread — RFC 2822 exige message-id entre angle brackets <>.
    // Caio 2026-05-11 (NF 690480): message_id_header está salvo sem brackets
    // em messages_inbox (`b20b1696-...@medcentercomercial.com.br`). Sem
    // normalização, Gmail/MS Outlook não reconhecem como reply.
    const msgIdOrigemRaw = (origem["message_id_header"] as string | null) ?? null;
    const refsOrigemRaw = (origem["references_header"] as string | null) ?? null;
    const msgIdOrigem = withAngleBrackets(msgIdOrigemRaw);
    const refsOrigem = normalizeReferencesHeader(refsOrigemRaw);
    const novoReferences = montaReferences(refsOrigem, msgIdOrigem);

    // 5. Caio 2026-05-06: usa sendGmailMessage (suporte a anexos + threading)
    // em vez de montar MIME inline.
    const { sendGmailMessage } = await import("../_shared/gmail-sender.ts");
    const { carregarAnexosParaEnvio, finalizarAnexosPosEnvio } = await import("../_shared/anexos-storage.ts");
    void accessToken; // gmail-sender refresha de novo (idempotente)

    const attachments = anexosIds.length > 0
      ? await carregarAnexosParaEnvio(supabaseSvc, anexosIds)
      : [];

    const extraHeaders: Record<string, string> = {};
    if (msgIdOrigem) extraHeaders["In-Reply-To"] = msgIdOrigem;
    if (novoReferences) extraHeaders["References"] = novoReferences;

    const sendResult = await sendGmailMessage({
      supabase: supabaseSvc,
      operadorId: op.id as string,
      destinatario: to,
      cc: ccLista,
      subject,
      texto,
      fromName: ((op as { nome_email_outbound?: string | null }).nome_email_outbound) ?? (op.nome as string | null),
      attachments,
      extraHeaders,
      threadId: threadIdParaEnvio,
    });

    if (!sendResult.ok) {
      return json({ ok: false, error: sendResult.error }, 500);
    }

    if (attachments.length > 0) {
      await finalizarAnexosPosEnvio(
        supabaseSvc,
        attachments.map((a) => ({ storage_path: a.storage_path, meta_id: a.meta_id })),
      );
    }

    const gmailMessageId = sendResult.messageId ?? undefined;
    const threadId = sendResult.threadId ?? undefined;

    // Caio 2026-05-12 (NF 920161): registra o email enviado em
    // cards_emails_outbound. Sem isso, gmail-poll-inbox detecta o próprio
    // email da Larissa como "operadora respondeu fora do Cockpit" (não acha
    // o gmail_message_id no set cockpitMsgIds) e reverte o card pra
    // AGUARDANDO_CLIENTE limpo. INSERT mínimo + ON CONFLICT pra idempotência.
    if (gmailMessageId && threadId) {
      const { error: outboundErr } = await supabaseSvc
        .from("cards_emails_outbound")
        .upsert(
          {
            card_id: cardId,
            operadora_id: op.id,
            gmail_message_id: gmailMessageId,
            gmail_thread_id: threadId,
            from_email: creds.email,
            to_email: to,
            subject,
            // Caio 2026-05-12 (NF 920161): persiste corpo pra IA usar como
            // contexto na próxima resposta do cliente.
            corpo_renderizado: texto,
          },
          { onConflict: "gmail_message_id" },
        );
      if (outboundErr) {
        console.warn(`responder-email-cliente: INSERT cards_emails_outbound falhou: ${outboundErr.message}`);
      }
    }

    // Caio 2026-05-12: regra de ciclo. Quando a operadora responde via Cockpit
    // composer DENTRO de uma recobrança oc=54, o card volta pra AGUARDANDO_CLIENTE
    // imediatamente (sem lançar nova oc no SSW — Bastão já tem 54 do ciclo
    // anterior). Próxima resposta do cliente re-dispara o vinculador → CLIENTE
    // RESPONDEU. Ciclo.
    //
    // Caio 2026-06-22 (INVARIANTE — bug NF 66820): AGUARDANDO_CLIENTE só pode
    // conter cards com oc=54. Se a última ocorrência do card NÃO é 54, ele está
    // em AGUARDANDO VOCÊ por uma oc de relacionamento (ex: 19/49/20) que AINDA
    // precisa de lançamento real no SSW pra ser tratada. Responder o cliente por
    // email NÃO trata essa oc — então o card NÃO pode sair de AGUARDANDO VOCÊ
    // só pelo email (senão a oc fica enterrada e o cliente nunca é notificado
    // dela, exatamente o que aconteceu na NF 66820 com a oc=19). Mantém state +
    // lock + propostas; a operadora ainda precisa lançar a oc de fato pra
    // destravar. Um card só sai de AGUARDANDO VOCÊ via lançamento de ocorrência.
    const ocCard = (card as { cod_ultima_ocorrencia?: number | null }).cod_ultima_ocorrencia ?? null;
    if (ocCard === 54) {
      await supabaseSvc.from("cards").update({
        state: "AGUARDANDO_CLIENTE",
        lock_aguardando_validacao: false,
        cliente_respondeu_em: null,
        ia_sugestao_oc_resposta: null,
        aviso_alteracao_oc: null,
      }).eq("id", cardId);

      await supabaseSvc.from("card_events").insert({
        card_id: cardId,
        event_type: "OperadoraRespondeuCockpitCardVoltouParaAguardandoCliente",
        actor_type: "operator",
        actor_id: op.id,
        payload: {
          gmail_message_id: gmailMessageId,
          gmail_thread_id: threadId,
          observacao: "Resposta manual da operadora via Cockpit composer (oc=54) — card volta pra AGUARDANDO_CLIENTE (sem nova oc no SSW). Próxima resposta do cliente re-aciona CLIENTE RESPONDEU.",
        },
      });
    } else {
      // oc ≠ 54: NÃO move pra AGUARDANDO_CLIENTE (invariante). Email saiu, mas a
      // oc de relacionamento continua aberta — card permanece em AGUARDANDO VOCÊ
      // com lock e propostas até a operadora lançar a ocorrência de fato.
      await supabaseSvc.from("card_events").insert({
        card_id: cardId,
        event_type: "OperadoraRespondeuCockpitMantidoEmAguardandoVoce",
        actor_type: "operator",
        actor_id: op.id,
        payload: {
          gmail_message_id: gmailMessageId,
          gmail_thread_id: threadId,
          cod_ultima_ocorrencia: ocCard,
          observacao: "Resposta manual da operadora via Cockpit composer, mas a última ocorrência do card NÃO é 54 (é de relacionamento, ainda não lançada no SSW). INVARIANTE 'AGUARDANDO_CLIENTE só oc=54': card permanece em AGUARDANDO VOCÊ com lock + propostas. Só sai daqui quando a operadora lançar a ocorrência de fato.",
        },
      });
    }

    // 7. Audit em card_events
    await supabaseSvc.from("card_events").insert({
      card_id: cardId,
      event_type: "RespostaManualEnviadaPeloCockpit",
      actor_type: "operator",
      actor_id: op.id,
      payload: {
        via: "gmail_oauth",
        from: creds.email,
        to,
        cc: ccLista,
        subject,
        in_reply_to: msgIdOrigem,
        references: novoReferences,
        gmail_message_id: gmailMessageId,
        gmail_thread_id: threadId,
        texto_preview: texto.slice(0, 300),
        mensagem_origem_id: origem["id"],
      },
    });

    return json({
      ok: true,
      gmail_message_id: gmailMessageId,
      thread_id: threadId,
      from: creds.email,
      to,
      cc: ccLista,
      // Caio 2026-06-22: front usa isso pra avisar a operadora que o card NÃO
      // saiu de AGUARDANDO VOCÊ (invariante oc=54). true quando oc≠54.
      permaneceu_em_aguardando_voce: ocCard !== 54,
      cod_ultima_ocorrencia: ocCard,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("responder-email-cliente fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

async function refreshAccessToken(
  supabase: ReturnType<typeof createClient>,
  operadorId: string,
  creds: { refresh_token: string; email: string; access_token_cache?: string; access_token_expira_em?: string },
  env: Record<string, string>,
): Promise<string> {
  const expira = creds.access_token_expira_em ? new Date(creds.access_token_expira_em).getTime() : 0;
  if (creds.access_token_cache && expira - Date.now() > 60_000) {
    return creds.access_token_cache;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env["GOOGLE_OAUTH_CLIENT_ID"]!,
      client_secret: env["GOOGLE_OAUTH_CLIENT_SECRET"]!,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const j = await res.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    throw new Error(`Gmail token refresh: ${j.error_description ?? j.error ?? `HTTP ${res.status}`}`);
  }

  await supabase
    .from("operadores")
    .update({
      gmail_oauth_credentials: {
        ...creds,
        access_token_cache: j.access_token,
        access_token_expira_em: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString(),
      },
    })
    .eq("id", operadorId);

  return j.access_token;
}

function montaReferences(refsOrigem: string | null, msgIdOrigem: string | null): string | null {
  // Header References: cadeia de Message-IDs anteriores (separados por espaço).
  // Quando responde, adiciona o Message-ID do email atual à cadeia.
  if (!msgIdOrigem) return refsOrigem;
  const partes: string[] = [];
  if (refsOrigem) partes.push(refsOrigem.trim());
  partes.push(msgIdOrigem.trim());
  return partes.join(" ");
}

// RFC 2822: Message-IDs em headers In-Reply-To/References precisam de
// angle brackets <id@host>. messages_inbox grava sem brackets — normaliza
// aqui antes de enviar pro Gmail.
function withAngleBrackets(id: string | null): string | null {
  if (!id) return null;
  const t = id.trim();
  if (!t) return null;
  if (t.startsWith("<") && t.endsWith(">")) return t;
  return `<${t.replace(/^<|>$/g, "")}>`;
}

function normalizeReferencesHeader(refs: string | null): string | null {
  if (!refs) return null;
  // Cadeia de Message-IDs separados por whitespace; cada um deve ter <>.
  const ids = refs.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  return ids.map((id) => withAngleBrackets(id)).filter(Boolean).join(" ");
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
