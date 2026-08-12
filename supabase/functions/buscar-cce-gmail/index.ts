// =============================================================================
// buscar-cce-gmail — quando a intranet Würth indica CCE (Obs "CCE ENVIADA"),
// o robô chama esta function pra ATIVAMENTE achar a carta no Gmail da Ingrid,
// anexá-la no card e dar as DUAS mensagens (Caio 2026-08-12):
//   (1) lembrar de trocar o endereço no SSW;
//   (2) confirmar que a CCE está anexada (ou avisar que não achou).
//
// Só há CCE porque houve tratativa: card existe + Ingrid notificou por e-mail.
// A carta chega num e-mail (novo) do cliente com o PDF anexo. Buscamos por
// NF + "CCE"/"carta de correção" na caixa do operador dono do card.
//
// Auth: service_role (chamada interna pelo robô). Idempotente por card_event.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  baixarAttachment,
  buscarMensagensPorQuery,
  extrairAnexos,
  getHeader,
  getMensagemFull,
  selecionarAnexosParaSalvar,
} from "../_shared/gmail-reader.ts";
import { loadOperadorGmailCreds, refreshGmailAccessToken } from "../_shared/gmail-sender.ts";
import { ehEmailCce, montarAvisosCce } from "../_shared/cce-wurth.ts";

const MIMES_PDF_IMG = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "use POST" }, 405);
  const env = Deno.env.toObject();
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const claimRole = (() => {
    try {
      return JSON.parse(atob(token.split(".")[1] ?? ""))?.role;
    } catch {
      return null;
    }
  })();
  if (token !== env["SUPABASE_SERVICE_ROLE_KEY"] && claimRole !== "service_role") {
    return json({ ok: false, error: "só chamada interna" }, 403);
  }

  const body = await req.json().catch(() => null) as { card_id?: string; nf?: string } | null;
  if (!body?.card_id) return json({ ok: false, error: "card_id obrigatório" }, 400);

  const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { persistSession: false },
  });

  // Idempotência: uma busca de CCE por card (o card_event marca).
  const { data: jaBuscou } = await supabase
    .from("card_events").select("id")
    .eq("card_id", body.card_id).eq("event_type", "CceGmailBuscada").limit(1);
  if (((jaBuscou as unknown[] | null)?.length ?? 0) > 0) {
    return json({ ok: true, skip: "cce já buscada neste card" });
  }

  const { data: card } = await supabase
    .from("cards").select("nf, assigned_operator_id").eq("id", body.card_id).maybeSingle();
  if (!card) return json({ ok: false, error: "card não encontrado" }, 404);
  const nf = (body.nf ?? (card as { nf?: string }).nf ?? "").replace(/\D/g, "");
  const opId = (card as { assigned_operator_id?: string }).assigned_operator_id;
  if (!nf || !opId) return json({ ok: false, error: "card sem nf/operador" }, 400);

  // Token Gmail do operador dono (a carta chega na caixa dele).
  const creds = await loadOperadorGmailCreds(supabase, opId);
  if (!creds) {
    await gravarAvisos(supabase, body.card_id, nf, false, "operador sem Gmail conectado");
    return json({ ok: true, anexada: false, motivo: "operador sem Gmail" });
  }
  const accessToken = await refreshGmailAccessToken(supabase, opId, creds);

  // Busca a CCE: NF + termo de carta de correção, últimos 60 dias.
  const query = `${nf} (CCE OR "carta de correção" OR "carta de correcao") newer_than:60d -in:chats`;
  let msgs: Array<{ id: string }>;
  try {
    msgs = await buscarMensagensPorQuery(accessToken, query, { maxResults: 10 });
  } catch (err) {
    await gravarAvisos(supabase, body.card_id, nf, false, `busca Gmail falhou: ${err instanceof Error ? err.message : err}`);
    return json({ ok: true, anexada: false, motivo: "busca falhou" });
  }

  // Acha a 1ª mensagem que É CCE de verdade e tem anexo PDF/imagem.
  let salvos = 0;
  let messageIdUsada: string | null = null;
  for (const m of msgs) {
    const full = await getMensagemFull(accessToken, m.id).catch(() => null);
    if (!full) continue;
    const subject = getHeader(full, "Subject");
    const corpo = extrairTextoSimples(full);
    if (!ehEmailCce(subject, corpo)) continue;

    const { salvar } = selecionarAnexosParaSalvar(extrairAnexos(full));
    const anexosPdf = salvar.filter((a) => MIMES_PDF_IMG.has(a.mimeType.toLowerCase()));
    if (anexosPdf.length === 0) continue;

    // registra a mensagem no inbox (pra ligar o anexo) se ainda não existe
    const midHeader = getHeader(full, "Message-ID");
    let inboxId: string | null = null;
    {
      const { data: ex } = await supabase.from("messages_inbox").select("id")
        .eq("message_id_header", midHeader).limit(1).maybeSingle();
      inboxId = (ex as { id?: string } | null)?.id ?? null;
    }
    if (!inboxId) {
      const { data: novo } = await supabase.from("messages_inbox").insert({
        card_id: body.card_id, canal: "email", remetente: getHeader(full, "From") ?? "",
        conteudo: corpo, message_id_header: midHeader,
        raw_payload: { gmail_message_id: m.id, subject, origem: "buscar-cce-gmail", match_via: "cce_intranet" },
        processing_status: "processed",
      }).select("id").maybeSingle();
      inboxId = (novo as { id?: string } | null)?.id ?? null;
    } else {
      await supabase.from("messages_inbox").update({ card_id: body.card_id }).eq("id", inboxId);
    }

    for (const anexo of anexosPdf) {
      try {
        const bytes = await baixarAttachment(accessToken, m.id, anexo.attachmentId);
        const uuid = crypto.randomUUID();
        const safe = anexo.filename.replace(/[^\w.\- ]/g, "_");
        const path = `inbound/${inboxId ?? body.card_id}/${uuid}-${safe}`;
        const { error: upErr } = await supabase.storage.from("email_anexos")
          .upload(path, bytes, { contentType: anexo.mimeType, upsert: false });
        if (upErr) continue;
        await supabase.from("email_anexos").insert({
          card_id: body.card_id, message_inbox_id: inboxId, origem: "inbound",
          storage_path: path, filename: anexo.filename, mime_type: anexo.mimeType, size_bytes: anexo.sizeBytes,
        });
        salvos++;
      } catch { /* segue */ }
    }
    messageIdUsada = m.id;
    if (salvos > 0) break;
  }

  await gravarAvisos(supabase, body.card_id, nf, salvos > 0, messageIdUsada ? `msg ${messageIdUsada}` : "sem e-mail de CCE encontrado");
  return json({ ok: true, anexada: salvos > 0, anexos: salvos });
});

async function gravarAvisos(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  cardId: string,
  nf: string,
  anexada: boolean,
  detalhe: string,
): Promise<void> {
  const avisos = montarAvisosCce(nf, anexada);
  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "CceGmailBuscada",
    actor_type: "system",
    actor_id: "buscar-cce-gmail",
    payload: { nf, anexada, detalhe, aviso_trocar_endereco: avisos.trocarEndereco, aviso_anexo: avisos.anexo },
  });
}

// deno-lint-ignore no-explicit-any
function extrairTextoSimples(full: any): string {
  // reusa a mesma extração leve; só o suficiente pra ehEmailCce.
  try {
    const parts = full?.payload?.parts ?? [full?.payload];
    for (const p of parts ?? []) {
      const data = p?.body?.data;
      if (data && (p.mimeType ?? "").includes("text/plain")) {
        return atob(data.replace(/-/g, "+").replace(/_/g, "/"));
      }
    }
  } catch { /* ignore */ }
  return full?.snippet ?? "";
}
