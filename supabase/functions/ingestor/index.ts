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

interface NormalizedMessage {
  canal: "whatsapp" | "email" | "sistema";
  remetente: string;
  conteudo: string;
  raw_payload: unknown;
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
      return jsonResponse(400, {
        error: "Não consegui extrair canal/remetente/conteudo do payload. " +
          "Formatos aceitos: Evolution webhook, Postmark inbound, ou " +
          "{canal, remetente, conteudo} genérico.",
        received: raw,
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
  const text = raw["TextBody"] ?? raw["textBody"] ?? raw["StrippedTextReply"];
  const subject = raw["Subject"] ?? raw["subject"];

  if (typeof from !== "string") return null;
  if (typeof text !== "string" || !text.trim()) return null;

  // Postmark dá "From" como display name + email. Extrai só o email.
  const emailMatch = from.match(/<([^>]+)>/) ?? from.match(/([^\s,;]+@[^\s,;]+)/);
  const remetente = emailMatch ? emailMatch[1] : from;

  const conteudo = (typeof subject === "string" && subject.trim()
    ? `[${subject.trim()}]\n\n${text}`
    : text);

  return { canal: "email", remetente: remetente.toLowerCase(), conteudo };
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
