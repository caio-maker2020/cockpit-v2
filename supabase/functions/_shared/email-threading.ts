// =============================================================================
// email-threading — helpers reusáveis pra responder thread Gmail do cliente.
//
// Extraído de responder-email-cliente/index.ts (Caio 2026-05-26) pra que o
// executor também possa enviar emails de confirmação ("Ok pessoal, iremos
// seguir com a reentrega...") respondendo a mesma thread em que o cliente
// autorizou a ação. Sem duplicar a lógica de normalizar Message-ID,
// montar References e buscar última inbound do card.
// =============================================================================

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

export interface ThreadingDaInbound {
  /** ID da row em messages_inbox que originou a thread. */
  mensagem_origem_id: string;
  /** Email do cliente que escreveu (vira To). */
  remetente: string;
  /** Subject original do inbound (já SEM "Re:" — caller decide se prefixa). */
  subject_original: string;
  /** Subject pronto pra reply (com "Re:" garantido na frente). */
  subject_reply: string;
  /** threadId Gmail (passar direto pro send API). */
  gmail_thread_id: string | null;
  /** Header In-Reply-To pronto (com angle brackets). */
  in_reply_to: string | null;
  /** Header References pronto (cadeia com angle brackets, espaço-separado). */
  references: string | null;
}

/**
 * Busca a última mensagem inbound do card no canal email + monta headers
 * de threading prontos pra `sendGmailMessage`. Retorna null se card não
 * tem inbound (sem thread pra responder).
 */
export async function carregarThreadingDaUltimaInbound(
  supabase: SupabaseClient,
  cardId: string,
): Promise<ThreadingDaInbound | null> {
  const { data: msgs } = await supabase
    .from("messages_inbox")
    .select("id, remetente, message_id_header, references_header, raw_payload")
    .eq("card_id", cardId)
    .eq("canal", "email")
    .order("recebido_em", { ascending: false })
    .limit(1);

  const origem = (msgs ?? [])[0] as Record<string, unknown> | undefined;
  if (!origem) return null;

  const remetente = origem["remetente"] as string | null;
  if (!remetente) return null;

  const rawPayload = (origem["raw_payload"] ?? {}) as Record<string, unknown>;
  // Postmark grava "Subject" capitalizado; Gmail polling grava "subject"
  // lowercase. Fallback "Sua mensagem" pra threads sem subject capturado.
  const subjectOrig =
    (rawPayload["subject"] as string | undefined) ??
    (rawPayload["Subject"] as string | undefined) ??
    "Sua mensagem";
  const subjectReply = /^re:\s/i.test(subjectOrig) ? subjectOrig : `Re: ${subjectOrig}`;

  const gmailThreadId = (rawPayload["gmail_thread_id"] as string | undefined) ?? null;

  const msgIdOrigemRaw = (origem["message_id_header"] as string | null) ?? null;
  const refsOrigemRaw = (origem["references_header"] as string | null) ?? null;
  const msgIdOrigem = withAngleBrackets(msgIdOrigemRaw);
  const refsOrigem = normalizeReferencesHeader(refsOrigemRaw);

  return {
    mensagem_origem_id: origem["id"] as string,
    remetente,
    subject_original: subjectOrig,
    subject_reply: subjectReply,
    gmail_thread_id: gmailThreadId,
    in_reply_to: msgIdOrigem,
    references: montaReferences(refsOrigem, msgIdOrigem),
  };
}

/** Monta header References anexando o Message-ID atual à cadeia anterior. */
export function montaReferences(refsOrigem: string | null, msgIdOrigem: string | null): string | null {
  if (!msgIdOrigem) return refsOrigem;
  const partes: string[] = [];
  if (refsOrigem) partes.push(refsOrigem.trim());
  partes.push(msgIdOrigem.trim());
  return partes.join(" ");
}

/**
 * RFC 2822: Message-IDs em headers In-Reply-To/References precisam de
 * angle brackets <id@host>. messages_inbox grava sem brackets — normaliza
 * antes de enviar pro Gmail.
 */
export function withAngleBrackets(id: string | null): string | null {
  if (!id) return null;
  const t = id.trim();
  if (!t) return null;
  if (t.startsWith("<") && t.endsWith(">")) return t;
  return `<${t.replace(/^<|>$/g, "")}>`;
}

export function normalizeReferencesHeader(refs: string | null): string | null {
  if (!refs) return null;
  const ids = refs.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  return ids.map((id) => withAngleBrackets(id)).filter(Boolean).join(" ");
}
