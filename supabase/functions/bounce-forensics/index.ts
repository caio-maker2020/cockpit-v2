// =============================================================================
// bounce-forensics — Edge Function (Deno) — DIAGNÓSTICO/ADMIN, sob demanda.
//
// Caio 2026-07-01 (investigação A): busca o RAW completo de um bounce pelo
// `gmail_message_id` usando o OAuth do OPERADOR dono da caixa (mesma credencial
// que o gmail-poll-inbox usa) e devolve o relatório forense estruturado
// (parseBounceForensics): headers do bounce, message/delivery-status, headers do
// e-mail ORIGINAL anexado (DKIM/SPF/DMARC), e o corpo "diagnostic information for
// administrators". NÃO crava causa — entrega evidência.
//
// SEGURANÇA: lê a caixa de um operador → interna/admin. verify_jwt=false (padrão
// das internas, INV-009) + guard opcional por segredo compartilhado
// (BOUNCE_FORENSICS_SECRET; se setado, exige header x-forensics-secret). NÃO é
// chamada por cron nem exposta ao front — é acionada manualmente pelo Caio.
//
// Uso:
//   POST { "nf": "575330" }                              → resolve operador+id via card
//   POST { "gmail_message_id": "...", "operador_email": "larissa@salexpress.com.br" }
//   POST { "gmail_message_id": "...", "operador_id": "uuid" }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  loadOperadorGmailCreds,
  refreshGmailAccessToken,
} from "../_shared/gmail-sender.ts";
import { parseBounceForensics } from "../_shared/bounce-forensics.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-forensics-secret",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function decodeRaw(b64url: string): string {
  const norm = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  return atob(padded); // string binária (Latin-1); parser decodifica por part
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Caio 2026-07-01 (item 1): como verify_jwt=false (não há auth de gateway), o
  // segredo é OBRIGATÓRIO. Sem BOUNCE_FORENSICS_SECRET setado → função desligada
  // (fail-closed): um leitor de caixa de operador NÃO pode ficar aberto.
  const secret = Deno.env.get("BOUNCE_FORENSICS_SECRET");
  if (!secret) {
    return json({ error: "BOUNCE_FORENSICS_SECRET não configurado — função desabilitada por segurança (verify_jwt=false)" }, 503);
  }
  if (req.headers.get("x-forensics-secret") !== secret) {
    return json({ error: "não autorizado" }, 401);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    // gmail-sender tipa `supabase` com um SupabaseClient de generics diferentes do
    // que createClient() infere aqui (TS2345 que executor/enviar-resposta também
    // arrastam). Cast preciso pro tipo do próprio param — sem `any`, sem poluir
    // as queries `.from()`.
    const sbGmail = supabase as Parameters<typeof loadOperadorGmailCreds>[0];

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    let gmailMessageId = (body.gmail_message_id as string | undefined) ?? null;
    let operadorId = (body.operador_id as string | undefined) ?? null;

    // Caio 2026-07-01 (item 2): resolução por NF só é permitida se for
    // INEQUÍVOCA. Preferir gmail_message_id + operador_id. Se a NF tiver >1 card
    // com bounce, NÃO escolher silenciosamente — devolver os candidatos e exigir
    // desambiguação explícita.
    if (body.nf && (!gmailMessageId || !operadorId)) {
      const { data: cardsNf } = await supabase
        .from("cards")
        .select("id, assigned_operator_id, ultimo_bounce_payload, ultimo_bounce_em")
        .eq("nf", String(body.nf))
        .not("ultimo_bounce_em", "is", null)
        .order("ultimo_bounce_em", { ascending: false });
      const lista = cardsNf ?? [];
      if (lista.length === 0) {
        return json({ error: `nenhum card com bounce pra NF ${String(body.nf)}` }, 404);
      }
      if (lista.length > 1) {
        return json({
          error: `NF ${String(body.nf)} tem ${lista.length} cards com bounce — ambíguo. Passe gmail_message_id + operador_id.`,
          candidatos: lista.map((c) => ({
            card_id: c.id,
            operador_id: c.assigned_operator_id,
            gmail_message_id: (c.ultimo_bounce_payload as Record<string, unknown> | null)?.gmail_message_id ?? null,
            ultimo_bounce_em: c.ultimo_bounce_em,
          })),
        }, 409);
      }
      const card = lista[0]!;
      const payload = (card.ultimo_bounce_payload as Record<string, unknown> | null) ?? {};
      operadorId = operadorId ?? (card.assigned_operator_id as string | null);
      gmailMessageId = gmailMessageId ?? ((payload.gmail_message_id as string | undefined) ?? null);
    }

    // Resolução do operador por e-mail.
    if (!operadorId && body.operador_email) {
      const { data: op } = await supabase
        .from("operadores")
        .select("id")
        .eq("email", String(body.operador_email))
        .maybeSingle();
      operadorId = (op?.id as string | undefined) ?? null;
    }

    if (!gmailMessageId) {
      return json({ error: "gmail_message_id ausente (passe gmail_message_id, ou nf de um card com bounce)" }, 400);
    }
    if (!operadorId) {
      return json({ error: "operador não resolvido (passe operador_id, operador_email, ou nf)" }, 400);
    }

    const creds = await loadOperadorGmailCreds(sbGmail, operadorId);
    if (!creds) {
      return json({ error: `operador ${operadorId} sem Gmail OAuth conectado` }, 400);
    }
    const accessToken = await refreshGmailAccessToken(sbGmail, operadorId, creds);

    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}?format=raw`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!r.ok) {
      return json({ error: `Gmail get HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` }, 502);
    }
    const msg = (await r.json()) as { raw?: string };
    if (!msg.raw) {
      return json({ error: "Gmail não retornou raw (id inválido nessa caixa? bounce foi de outro operador?)" }, 404);
    }

    const forensics = parseBounceForensics(decodeRaw(msg.raw));

    return json({
      ok: true,
      gmail_message_id: gmailMessageId,
      operador_id: operadorId,
      caixa: creds.email,
      forensics,
    }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
