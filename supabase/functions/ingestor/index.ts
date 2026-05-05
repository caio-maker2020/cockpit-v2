// =============================================================================
// ingestor — recebe webhooks (Evolution WhatsApp / Postmark inbound / manual)
// e materializa em messages_inbox + enfileira pgmq.agent_intake.
//
// Aceita 3 formatos de payload (auto-detect pelo shape):
//   1. Evolution API webhook  → body.data.key.remoteJid + body.data.message.*
//   2. Postmark inbound       → body.From + body.Subject + body.TextBody
//   3. Genérico/manual        → { canal, remetente, conteudo, raw_payload? }
//
// Sai de fora dessa Edge Function:
//   - Classificação (triador, modelo Sonnet 4.6)
//   - Vinculação (vinculador, busca card existente ou cria via Bastão/SSW)
//   - Resposta ao cliente
//
// Tudo aqui é determinístico — só normaliza payload, escreve em DB, enfileira.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { invokeNext } from "../_shared/invoke-next.ts";

interface NormalizedMessage {
  canal: "whatsapp" | "email" | "sistema";
  remetente: string;
  conteudo: string;
  raw_payload: unknown;
  // Headers de thread (preenchidos só pra Postmark inbound). Permitem que
  // o vinculador linke próximas respostas à mesma thread (= mesmo card).
  message_id_header?: string | null;
  in_reply_to_header?: string | null;
  references_header?: string | null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const raw = await req.json().catch(() => null);
    if (!raw || typeof raw !== "object") {
      return jsonResponse(400, { error: "Body precisa ser JSON válido" });
    }

    const normalized = normalizePayload(raw as Record<string, unknown>);
    if (!normalized) {
      // Quando rejeita, loga as keys de top-level + por que cada parser falhou.
      // Sem isso, debugar por que um Postmark inbound real não virou card era
      // adivinhação (precisava ver o JSON cru no provider).
      const rawObj = raw as Record<string, unknown>;
      const topKeys = Object.keys(rawObj);
      const diag = {
        evolution_reason: diagnoseEvolution(rawObj),
        postmark_reason: diagnosePostmark(rawObj),
        generic_reason: diagnoseGeneric(rawObj),
      };
      console.warn(
        "ingestor rejeitou payload:",
        JSON.stringify({ top_keys: topKeys, diagnostico: diag }),
      );
      return jsonResponse(400, {
        error: "Não consegui extrair canal/remetente/conteudo do payload. " +
          "Formatos aceitos: Evolution webhook, Postmark inbound, ou " +
          "{canal, remetente, conteudo} genérico.",
        diagnostico: diag,
        top_keys: topKeys,
      });
    }

    // Persiste a mensagem bruta (vinculação/classificação acontecem depois)
    const { data: inboxRow, error: insErr } = await supabase
      .from("messages_inbox")
      .insert({
        canal: normalized.canal,
        remetente: normalized.remetente,
        conteudo: normalized.conteudo,
        raw_payload: normalized.raw_payload as Record<string, unknown>,
        processing_status: "pending",
        message_id_header: normalized.message_id_header ?? null,
        in_reply_to_header: normalized.in_reply_to_header ?? null,
        references_header: normalized.references_header ?? null,
      })
      .select("id, recebido_em")
      .single();

    if (insErr) {
      console.error("INSERT messages_inbox falhou:", insErr);
      return jsonResponse(500, { error: `INSERT messages_inbox: ${insErr.message}` });
    }

    // Enfileira em pgmq.agent_intake — triador consome depois
    const { error: enqErr } = await supabase.rpc("enqueue_to_pgmq", {
      queue_name: "agent_intake",
      payload: {
        message_id: inboxRow.id,
        canal: normalized.canal,
        remetente: normalized.remetente,
        recebido_em: inboxRow.recebido_em,
      },
    });

    if (enqErr) {
      // Mensagem já está em messages_inbox; sem a fila, triador pode pegar
      // via fallback (cron poll de messages_inbox WHERE processing_status='pending').
      console.warn(
        `Enqueue agent_intake falhou (msg ${inboxRow.id}): ${enqErr.message}`,
      );
    } else {
      // Acorda triador na hora — sem isso o card só apareceria no próximo
      // tick do cron (até 1min). Fire-and-forget: a request original retorna
      // imediatamente. Se o invoke falhar, o cron de 1min é o fallback.
      invokeNext({
        functionName: "triador",
        supabaseUrl: env["SUPABASE_URL"]!,
        serviceRoleKey: env["SUPABASE_SERVICE_ROLE_KEY"]!,
      });
    }

    return jsonResponse(200, {
      ok: true,
      message_id: inboxRow.id,
      canal: normalized.canal,
      enqueued: !enqErr,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("ingestor fatal:", msg);
    return jsonResponse(500, { error: msg });
  }
});

// =============================================================================

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePayload(raw: Record<string, unknown>): NormalizedMessage | null {
  // Evolution API: tem `data.key.remoteJid` + `data.message`
  const evo = tryEvolution(raw);
  if (evo) return { ...evo, raw_payload: raw };

  // Postmark inbound: tem `From` + `TextBody`/`HtmlBody` + `Subject`
  const pm = tryPostmark(raw);
  if (pm) return { ...pm, raw_payload: raw };

  // Genérico: { canal, remetente, conteudo }
  const gen = tryGeneric(raw);
  if (gen) return { ...gen, raw_payload: raw };

  return null;
}

function tryEvolution(raw: Record<string, unknown>): Omit<NormalizedMessage, "raw_payload"> | null {
  const data = raw["data"];
  if (!data || typeof data !== "object") return null;
  const dataObj = data as Record<string, unknown>;

  const key = dataObj["key"];
  const message = dataObj["message"];
  if (!key || typeof key !== "object") return null;
  if (!message || typeof message !== "object") return null;

  const remoteJid = (key as Record<string, unknown>)["remoteJid"];
  if (typeof remoteJid !== "string") return null;

  const msgObj = message as Record<string, unknown>;
  const conversation = msgObj["conversation"];
  const extended = msgObj["extendedTextMessage"];
  const extText = extended && typeof extended === "object"
    ? (extended as Record<string, unknown>)["text"]
    : undefined;

  const conteudo = (typeof conversation === "string" ? conversation : "")
    || (typeof extText === "string" ? extText : "");
  if (!conteudo) return null;

  // Strip @s.whatsapp.net / @g.us; descarta grupos
  if (/@g\.us$/.test(remoteJid)) return null;
  let remetente = remoteJid.replace(/@s\.whatsapp\.net$/, "").replace(/@g\.us$/, "");
  // Fix do 9º dígito brasileiro
  if (/^55\d{10}$/.test(remetente)) {
    remetente = remetente.slice(0, 4) + "9" + remetente.slice(4);
  }

  return { canal: "whatsapp", remetente, conteudo };
}

function tryPostmark(raw: Record<string, unknown>): Omit<NormalizedMessage, "raw_payload"> | null {
  const from = raw["From"] ?? raw["from"];
  if (typeof from !== "string") return null;

  // Postmark inbound entrega TextBody, HtmlBody, StrippedTextReply (quando é
  // um reply). Emails modernos (Apple Mail, Outlook web, alguns Gmail) chegam
  // HTML-only com TextBody vazio. Antes a gente só lia TextBody e devolvia
  // 400 "não consegui extrair conteudo" — mensagem nunca virava card.
  // Fallback: TextBody → StrippedTextReply → HtmlBody (com strip de tags).
  const textBody = pickStringField(raw, ["TextBody", "textBody"]);
  const stripped = pickStringField(raw, ["StrippedTextReply", "strippedTextReply"]);
  const htmlBody = pickStringField(raw, ["HtmlBody", "htmlBody"]);

  let text: string | null = null;
  if (textBody && textBody.trim()) text = textBody;
  else if (stripped && stripped.trim()) text = stripped;
  else if (htmlBody && htmlBody.trim()) text = htmlToPlainText(htmlBody);

  if (!text || !text.trim()) {
    // Não tem corpo nenhum. Não é Postmark inbound válido.
    return null;
  }

  const subject = raw["Subject"] ?? raw["subject"];

  // Postmark dá "From" como display name + email. Extrai só o email.
  const emailMatch = from.match(/<([^>]+)>/) ?? from.match(/([^\s,;]+@[^\s,;]+)/);
  const remetente = emailMatch ? emailMatch[1] : from;

  const conteudo = (typeof subject === "string" && subject.trim()
    ? `[${subject.trim()}]\n\n${text}`
    : text);

  // Extrai headers de thread (Message-ID, In-Reply-To, References).
  // Postmark traz como array Headers: [{Name, Value}, ...].
  const headers = raw["Headers"] ?? raw["headers"];
  const headersArr = Array.isArray(headers) ? headers as Array<Record<string, unknown>> : [];
  const findHeader = (name: string): string | null => {
    const lower = name.toLowerCase();
    for (const h of headersArr) {
      const hName = String(h["Name"] ?? h["name"] ?? "").toLowerCase();
      if (hName === lower) {
        const v = h["Value"] ?? h["value"];
        return typeof v === "string" ? v : null;
      }
    }
    return null;
  };

  return {
    canal: "email",
    remetente: remetente.toLowerCase(),
    conteudo,
    message_id_header: findHeader("Message-ID"),
    in_reply_to_header: findHeader("In-Reply-To"),
    references_header: findHeader("References"),
  };
}

function pickStringField(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string") return v;
  }
  return null;
}

/**
 * HTML → texto plano. Não é parser perfeito (não montamos DOM no Edge), mas
 * cobre o que aparece em email: <br>, <p>, <div>, links, listas, e entities
 * comuns. Dá pro triador classificar sem ruído.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tryGeneric(raw: Record<string, unknown>): Omit<NormalizedMessage, "raw_payload"> | null {
  const canal = raw["canal"];
  const remetente = raw["remetente"];
  const conteudo = raw["conteudo"];

  if (typeof canal !== "string") return null;
  if (typeof remetente !== "string") return null;
  if (typeof conteudo !== "string") return null;
  if (!["whatsapp", "email", "sistema"].includes(canal)) return null;

  return {
    canal: canal as "whatsapp" | "email" | "sistema",
    remetente,
    conteudo,
  };
}

// =============================================================================
// Diagnóstico: explica em uma string POR QUE cada parser rejeitou. Aparece nos
// logs do Supabase + na resposta 400, então debug fica em 1 olhada.
// =============================================================================

function diagnoseEvolution(raw: Record<string, unknown>): string {
  const data = raw["data"];
  if (!data || typeof data !== "object") return "sem campo 'data'";
  const dataObj = data as Record<string, unknown>;
  if (!dataObj["key"] || typeof dataObj["key"] !== "object") return "sem 'data.key'";
  if (!dataObj["message"] || typeof dataObj["message"] !== "object") return "sem 'data.message'";
  const remoteJid = (dataObj["key"] as Record<string, unknown>)["remoteJid"];
  if (typeof remoteJid !== "string") return "'data.key.remoteJid' não é string";
  if (/@g\.us$/.test(remoteJid)) return "grupo (@g.us) — descartado";
  const msgObj = dataObj["message"] as Record<string, unknown>;
  if (!msgObj["conversation"] && !msgObj["extendedTextMessage"]) {
    return "sem texto (nem conversation nem extendedTextMessage)";
  }
  return "ok (não deveria ter caído aqui)";
}

function diagnosePostmark(raw: Record<string, unknown>): string {
  const from = raw["From"] ?? raw["from"];
  if (typeof from !== "string") return "sem campo 'From'";
  const textBody = pickStringField(raw, ["TextBody", "textBody"]);
  const stripped = pickStringField(raw, ["StrippedTextReply", "strippedTextReply"]);
  const htmlBody = pickStringField(raw, ["HtmlBody", "htmlBody"]);
  const has = (s: string | null) => s != null && s.trim().length > 0;
  if (!has(textBody) && !has(stripped) && !has(htmlBody)) {
    return "sem corpo (TextBody, StrippedTextReply e HtmlBody todos vazios/ausentes)";
  }
  return "ok (não deveria ter caído aqui)";
}

function diagnoseGeneric(raw: Record<string, unknown>): string {
  const canal = raw["canal"];
  if (typeof canal !== "string") return "sem 'canal'";
  if (!["whatsapp", "email", "sistema"].includes(canal)) {
    return `'canal' inválido (${canal}) — esperado whatsapp|email|sistema`;
  }
  if (typeof raw["remetente"] !== "string") return "sem 'remetente'";
  if (typeof raw["conteudo"] !== "string") return "sem 'conteudo'";
  return "ok (não deveria ter caído aqui)";
}
