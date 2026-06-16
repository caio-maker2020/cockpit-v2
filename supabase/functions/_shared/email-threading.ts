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

// =============================================================================
// carregarThreadDaTratativaAtual — "continuar a tratativa" (Caio 2026-06-16).
//
// Email proativo ao cliente deve CONTINUAR a thread Gmail da tratativa do card
// (mantém o histórico junto), em vez de abrir thread nova. Só abre thread nova
// quando a tratativa de fato encerrou. Fronteira determinística: card finalizado
// = recebeu oc finalizadora (01/30/32, mesmo conjunto de OCORRENCIAS_FINALIZADORAS
// em sync-bastao que fecha card RESOLVIDO). Enquanto não houve finalizadora DEPOIS
// do último email, é a mesma tratativa → reusa a thread.
//
// Caso âncora NF 2342 (6→49→54→55→14→19): a oc=19 (romaneio) cai na MESMA thread
// da oc=54 porque a oc=14 no meio NÃO é finalizadora.
//
// Fonte da thread: último outbound do card em `cards_emails_outbound`. Respostas
// do cliente caem nessa mesma thread Gmail, então o último outbound basta.
// =============================================================================

/** Finalizadoras de card (= OCORRENCIAS_FINALIZADORAS de sync-bastao). 01 entrega
 *  normal; 30/32 finaliza CT-e. Card sem nenhuma dessas = tratativa aberta. */
const OCS_FINALIZADORAS_TRATATIVA: ReadonlySet<number> = new Set([1, 30, 32]);

export interface ThreadDaTratativa {
  /** threadId Gmail pra passar direto pro send API. */
  gmail_thread_id: string;
  /** Header In-Reply-To pronto (com angle brackets) ou null. */
  in_reply_to: string | null;
  /** Header References pronto ou null. */
  references: string | null;
  /** Subject com "Re:" garantido, derivado do último email da tratativa. */
  subject_reply: string;
}

/**
 * Parser do formato de data do SSW ("dd/mm/yy hh:mm" BRT) → epoch ms UTC.
 * Cópia da função pura homônima em confirmar-acao-executada-ssw.ts (mesma fonte
 * de `historico_ssw[].data`); replicada aqui pra não arrastar o ssw-client.
 */
function parseDataSswBrt(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]), yy = Number(m[3]);
  const hh = Number(m[4]), mi = Number(m[5]);
  // BRT (-03) → UTC: soma 3h ao montar o epoch.
  return Date.UTC(2000 + yy, mm - 1, dd, hh + 3, mi);
}

/**
 * Resolve a thread Gmail da tratativa ATUAL do card pra um envio proativo.
 * Retorna a thread a CONTINUAR, ou `null` se deve abrir thread nova (sem email
 * anterior, OU tratativa encerrada por finalizadora 01/30/32 depois do último
 * email). Best-effort: qualquer erro vira `null` (degrada pra thread nova, nunca
 * derruba o envio).
 */
export async function carregarThreadDaTratativaAtual(
  supabase: SupabaseClient,
  cardId: string,
): Promise<ThreadDaTratativa | null> {
  try {
    // 1. Último email outbound do card.
    const { data: outRows } = await supabase
      .from("cards_emails_outbound")
      .select("gmail_thread_id, message_id_header, subject, sent_at")
      .eq("card_id", cardId)
      .order("sent_at", { ascending: false })
      .limit(1);

    const ultimoOut = (outRows ?? [])[0] as Record<string, unknown> | undefined;
    if (!ultimoOut) return null; // primeiro contato → thread nova
    const threadId = (ultimoOut["gmail_thread_id"] as string | null) ?? null;
    if (!threadId) return null;

    const sentAtRaw = ultimoOut["sent_at"] as string | null;
    const sentAtMs = sentAtRaw ? Date.parse(sentAtRaw) : NaN;

    // 2. Houve finalizadora (01/30/32) DEPOIS do último email? Se sim, a tratativa
    //    anterior encerrou → thread nova. historico_ssw vazio/null = sem
    //    finalizadora = tratativa aberta (seguro: reusa thread).
    const { data: cardRow } = await supabase
      .from("cards")
      .select("historico_ssw")
      .eq("id", cardId)
      .maybeSingle();

    const historico = (cardRow?.historico_ssw ?? []) as Array<Record<string, unknown>>;
    if (Array.isArray(historico) && !Number.isNaN(sentAtMs)) {
      const finalizouDepois = historico.some((o) => {
        const codigo = Number(o["codigo"]);
        if (!OCS_FINALIZADORAS_TRATATIVA.has(codigo)) return false;
        const t = parseDataSswBrt(o["data"] as string | null | undefined);
        return t != null && t > sentAtMs;
      });
      if (finalizouDepois) return null; // tratativa encerrada → thread nova
    }

    // 3. Reusa a thread da tratativa.
    const msgId = withAngleBrackets((ultimoOut["message_id_header"] as string | null) ?? null);
    const subjOrig = (ultimoOut["subject"] as string | null) ?? "Sua tratativa";
    const subjectReply = /^re:\s/i.test(subjOrig) ? subjOrig : `Re: ${subjOrig}`;

    return {
      gmail_thread_id: threadId,
      in_reply_to: msgId,
      references: msgId, // único elo conhecido; cadeia completa não é necessária pro Gmail agrupar
      subject_reply: subjectReply,
    };
  } catch (_e) {
    return null; // best-effort: nunca derruba o envio
  }
}
