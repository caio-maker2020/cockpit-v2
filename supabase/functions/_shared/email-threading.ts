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
// FONTE ÚNICA do parser de "DD/MM/YY HH:MM" do SSW (antes cópia privada — Caio 2026-06-25).
import { parseSswDataHoraBrt as parseDataSswBrt } from "./ssw-data-hora.ts";
import { ehMessageIdFantasma } from "./email-mime.ts";

type SupabaseClient = ReturnType<typeof createClient>;

// =============================================================================
// Prefixo de reply — fix Outlook (Caio 2026-08-18, NFs 1597524/58203/55482).
//
// A detecção antiga (/^re:\s/i) só reconhecia "Re:". Quando o cliente responde
// pelo Outlook PT-BR, o subject volta "RES: X" — o Cockpit grudava "Re: " por
// cima ("Re: RES: X"), criando um assunto que não existe na conversa do
// cliente. O Gmail agrupa por References e não liga; o Outlook/Exchange agrupa
// por Thread-Index + assunto normalizado → nossa resposta virava CONVERSA NOVA
// na caixa do cliente.
//
// Regra: se o assunto JÁ tem qualquer prefixo de reply/forward (em qualquer
// idioma comum, empilhado ou não), fica EXATAMENTE como o cliente mandou —
// é o que qualquer client de e-mail faz ao responder. Só prefixa "Re: " em
// assunto sem prefixo nenhum.
// =============================================================================

/** Prefixos de reply/forward dos clients comuns: Re/RES (pt), RE, ENC (pt),
 *  FW/FWD, RV (es), AW/WG (de), SV (sv/no/da), VS (fi), TR (fr). Aceita
 *  variante numerada tipo "RE[2]:". */
const PREFIXO_REPLY_FORWARD_RE = /^\s*(re|res|enc|fw|fwd|rv|aw|wg|sv|vs|tr)(\[\d+\])?\s*:/i;

export function temPrefixoReplyOuForward(subject: string): boolean {
  return PREFIXO_REPLY_FORWARD_RE.test(subject);
}

/** Subject de reply: mantém intacto se já tem prefixo; senão prefixa "Re: ".
 *
 *  Carlos 2026-09-09 (NF 7481 BIOMEDICAL): NÃO faz trim. O Exchange racha a
 *  conversa quando o assunto normalizado difere do tópico — a cliente mandou
 *  " Recusa Total — ..." (espaço na frente), a gente devolveu "Re: Recusa Total"
 *  e o Outlook dela abriu conversa nova. O Outlook, ao responder, gera
 *  "RE:  Recusa Total" (espaço duplo) — é o que fazemos agora. */
export function garantirPrefixoReply(subjectOrig: string): string {
  const s = subjectOrig ?? "";
  if (!s.trim()) return "Re: Sua mensagem";
  return temPrefixoReplyOuForward(s) ? s : `Re: ${s}`;
}

/**
 * Thread-Index do inbound (header proprietário que o Outlook/Exchange usa como
 * chave primária de agrupamento de conversa). Ecoado de volta no reply, faz o
 * Outlook encadear independente do assunto. Fontes:
 *  - `raw_payload.thread_index` (gmail-poll-inbox grava a partir de 2026-08-18);
 *  - Postmark inbound: array `Headers` [{Name, Value}] do payload cru (cobre
 *    retroativamente mensagens antigas do ingestor).
 * Best-effort: cliente não-Outlook não manda o header → null (sem efeito).
 */
export function extrairThreadIndex(rawPayload: Record<string, unknown>): string | null {
  const direto = rawPayload["thread_index"];
  if (typeof direto === "string" && direto.trim()) return direto.trim();
  const headers = rawPayload["Headers"];
  if (Array.isArray(headers)) {
    for (const h of headers) {
      const item = h as Record<string, unknown>;
      if (typeof item["Name"] === "string" && item["Name"].toLowerCase() === "thread-index") {
        const v = item["Value"];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  }
  return null;
}

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
  /** Header Thread-Index do inbound (agrupamento nativo do Outlook) ou null. */
  thread_index: string | null;
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
  const subjectReply = garantirPrefixoReply(subjectOrig);

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
    thread_index: extrairThreadIndex(rawPayload),
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
  // Carlos 2026-09-09: `cockpit-...` foi gerado localmente e o Gmail
  // reescreveu no envio — nunca existiu no fio. Vira null pra NUNCA ser âncora.
  if (ehMessageIdFantasma(t)) return null;
  if (t.startsWith("<") && t.endsWith(">")) return t;
  return `<${t.replace(/^<|>$/g, "")}>`;
}

export function normalizeReferencesHeader(refs: string | null): string | null {
  if (!refs) return null;
  const ids = refs.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  // withAngleBrackets já descarta ids fantasmas (cockpit-...) da cadeia.
  const out = ids.map((id) => withAngleBrackets(id)).filter(Boolean).join(" ");
  return out.length > 0 ? out : null;
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
  /** Header Thread-Index (agrupamento nativo do Outlook) ou null. */
  thread_index: string | null;
  /** Subject com "Re:" garantido, derivado do último email da tratativa. */
  subject_reply: string;
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
    // Caio 2026-06-17 (mig 212): card pode ter juntado MAIS DE UMA thread Gmail
    // (feature de junção por NF/assunto). Se a operadora escolheu uma tratativa
    // específica (cards.tratativa_email_escolhida = gmail_thread_id), a resposta
    // CONTINUA NESSA thread — não na "última outbound" (que pode ser de outra
    // tratativa). O "Para" continua vindo do front via extras.email_destinatarios
    // (= responder_para da tratativa escolhida); aqui só resolvemos os headers.
    const { data: cardRow } = await supabase
      .from("cards")
      .select("historico_ssw, tratativa_email_escolhida")
      .eq("id", cardId)
      .maybeSingle();

    const escolhida = (cardRow?.tratativa_email_escolhida as string | null) ?? null;
    if (escolhida) {
      const t = await resolverThreadEspecifica(supabase, cardId, escolhida);
      if (t) return t; // não resolveu (thread sumiu) → degrada pro fluxo padrão
    }

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

    // 3. Reusa a thread da tratativa. Carlos 2026-09-09: a âncora do
    //    In-Reply-To/References é a mensagem MAIS RECENTE da thread com
    //    Message-ID real (inbound do cliente OU nosso outbound), e o
    //    Thread-Index vem do último inbound DESSA thread — mesma regra da
    //    tratativa escolhida (resolverThreadEspecifica). Antes preferia o
    //    outbound mesmo com id fantasma `cockpit-...` (que o Gmail reescreveu) e
    //    só olhava Thread-Index se o último inbound do CARD fosse desta thread →
    //    e-mail proativo repetido saía sem âncora nenhuma (WURTH NF 683869).
    const ancorado = await resolverThreadEspecifica(supabase, cardId, threadId);
    if (ancorado) return ancorado;

    // Thread sem nenhuma mensagem legível (não deveria acontecer: o próprio
    // ultimoOut está nela). Degrada: threadId agrupa no Gmail; sem headers.
    const subjOrig = (ultimoOut["subject"] as string | null) ?? "Sua tratativa";
    return {
      gmail_thread_id: threadId,
      in_reply_to: null,
      references: null,
      thread_index: null,
      subject_reply: garantirPrefixoReply(subjOrig),
    };
  } catch (_e) {
    return null; // best-effort: nunca derruba o envio
  }
}

/**
 * Resolve os headers de threading pra uma thread Gmail ESPECÍFICA (a tratativa
 * que a operadora escolheu num card com múltiplas threads — mig 212). Âncora do
 * In-Reply-To/References = mensagem MAIS RECENTE da thread (inbound OU outbound),
 * pra a resposta encaixar no fim da conversa certa. Subject derivado dessa âncora.
 * Retorna null se a thread não tem nenhuma mensagem no card (degrada pro padrão).
 */
async function resolverThreadEspecifica(
  supabase: SupabaseClient,
  cardId: string,
  threadId: string,
): Promise<ThreadDaTratativa | null> {
  // Último outbound NESSA thread.
  const { data: outRows } = await supabase
    .from("cards_emails_outbound")
    .select("message_id_header, subject, sent_at")
    .eq("card_id", cardId)
    .eq("gmail_thread_id", threadId)
    .order("sent_at", { ascending: false })
    .limit(1);

  // Última inbound NESSA thread (filtro no jsonb raw_payload.gmail_thread_id).
  const { data: inRows } = await supabase
    .from("messages_inbox")
    .select("message_id_header, references_header, raw_payload, recebido_em")
    .eq("card_id", cardId)
    .eq("raw_payload->>gmail_thread_id", threadId)
    .order("recebido_em", { ascending: false })
    .limit(1);

  const out = (outRows ?? [])[0] as Record<string, unknown> | undefined;
  const inb = (inRows ?? [])[0] as Record<string, unknown> | undefined;
  if (!out && !inb) return null;

  const a = escolherAncoraThread({
    outbound: out
      ? {
        message_id_header: (out["message_id_header"] as string | null) ?? null,
        subject: (out["subject"] as string | null) ?? null,
        sent_at: (out["sent_at"] as string | null) ?? null,
      }
      : null,
    inbound: inb
      ? {
        message_id_header: (inb["message_id_header"] as string | null) ?? null,
        references_header: (inb["references_header"] as string | null) ?? null,
        raw_payload: (inb["raw_payload"] ?? {}) as Record<string, unknown>,
        recebido_em: (inb["recebido_em"] as string | null) ?? null,
      }
      : null,
  });

  return {
    gmail_thread_id: threadId,
    in_reply_to: a.in_reply_to,
    references: a.references,
    thread_index: a.thread_index,
    subject_reply: garantirPrefixoReply(a.subject_original),
  };
}

// =============================================================================
// escolherAncoraThread — função PURA (testável) que decide os headers de reply
// a partir do último outbound e do último inbound de UMA thread.
//
// Regras (Carlos 2026-09-09):
//  • Âncora do In-Reply-To = mensagem mais recente com Message-ID REAL.
//    Ids `cockpit-...` são fantasmas (Gmail reescreveu) → withAngleBrackets
//    devolve null e a âncora cai pro inbound do cliente, se houver.
//  • References = cadeia do inbound (sem fantasmas) + id do inbound + id do
//    nosso outbound quando ele é a âncora — o cliente consegue resolver todos.
//  • Thread-Index SEMPRE do inbound (é o Outlook do cliente que o gera).
//  • Assunto = o da mensagem-âncora (mantém o tópico da conversa do cliente).
// =============================================================================

export interface AncoraOutbound {
  message_id_header: string | null;
  subject: string | null;
  sent_at: string | null;
}
export interface AncoraInbound {
  message_id_header: string | null;
  references_header: string | null;
  raw_payload: Record<string, unknown>;
  recebido_em: string | null;
}
export interface AncoraThread {
  in_reply_to: string | null;
  references: string | null;
  thread_index: string | null;
  /** Assunto cru da mensagem-âncora (SEM garantir prefixo — caller decide). */
  subject_original: string;
}

export function escolherAncoraThread(p: {
  outbound: AncoraOutbound | null;
  inbound: AncoraInbound | null;
}): AncoraThread {
  const { outbound: out, inbound: inb } = p;
  const outMs = out?.sent_at ? Date.parse(out.sent_at) : -Infinity;
  const inMs = inb?.recebido_em ? Date.parse(inb.recebido_em) : -Infinity;

  const threadIndex = inb ? extrairThreadIndex(inb.raw_payload) : null;
  const inbId = inb ? withAngleBrackets(inb.message_id_header) : null;
  const inbRefs = inb ? normalizeReferencesHeader(inb.references_header) : null;
  const inbChain = montaReferences(inbRefs, inbId); // cadeia do cliente (sem fantasmas)
  const outId = out ? withAngleBrackets(out.message_id_header) : null; // null se fantasma
  const subjInb = inb
    ? ((inb.raw_payload["subject"] as string | undefined) ??
      (inb.raw_payload["Subject"] as string | undefined) ?? null)
    : null;
  const subjOut = out?.subject ?? null;

  const outMaisRecente = !!out && outMs >= inMs;
  const subjectAncora = (outMaisRecente ? (subjOut ?? subjInb) : (subjInb ?? subjOut)) ?? "Sua tratativa";

  if (outMaisRecente && outId) {
    // Nosso outbound é o mais recente E tem id real → âncora nele, cadeia completa.
    return {
      in_reply_to: outId,
      references: montaReferences(inbChain, outId),
      thread_index: threadIndex,
      subject_original: subjectAncora,
    };
  }
  if (inbId) {
    // Inbound é o mais recente, OU o outbound mais recente tem id fantasma →
    // âncora no cliente (id que ele com certeza resolve).
    return {
      in_reply_to: inbId,
      references: inbChain,
      thread_index: threadIndex,
      subject_original: subjectAncora,
    };
  }
  // Nenhum id real: threadId agrupa no Gmail; Thread-Index (se houver) ainda
  // ajuda o Outlook; sem In-Reply-To/References.
  return {
    in_reply_to: null,
    references: inbChain,
    thread_index: threadIndex,
    subject_original: subjectAncora,
  };
}
