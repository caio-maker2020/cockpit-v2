import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

import { supabase } from "@/lib/supabase";
import { remetenteCruDoAgentState } from "@/lib/contatos";
import { useAuth } from "@/contexts/AuthContext";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import type {
  CanalOrigem,
  CardEventRow,
  CardRow,
  HistoricoSswOcorrencia,
  MessageInboxRow,
  TodoRow,
} from "@/lib/types";
import { canalIcon, relativeShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AnexosUploader, type AnexoUploaded } from "./AnexosUploader";
import { ModalReportarErroLancamento } from "./ModalReportarErroLancamento";
import { ModalEvidencia } from "./ModalEvidencia";
import { HistoricoEventosCard } from "./HistoricoEventosCard";
import EmailThread, { type EmailThreadMessage } from "./EmailThread";
import { useTratativasEmail } from "@/hooks/useTratativasEmail";
import { TratativasEmailMultiplas } from "./TratativasEmailMultiplas";
import { PainelTratativaDetectada } from "./PainelTratativaDetectada";

const SENT_EVENT_TYPES = ["RespostaManualEnviada", "RespostaEnviada", "AcaoExecutada"];
const ENVIO_DESABILITADO =
  String(import.meta.env.VITE_ENVIO_DESABILITADO ?? "true").toLowerCase() === "true";

type AbaId = "mensagens" | "resposta" | "eventos" | "ssw";

export function ConversationTabs({ card, initialTab }: { card: CardRow; initialTab?: AbaId }) {
  const [aba, setAba] = useState<AbaId>(initialTab ?? "mensagens");


  // Indicador "nova sugestão" na aba Resposta
  const { data: respostaTodo } = useQuery({
    queryKey: ["resposta-todo", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data } = await supabase!
        .from("todos")
        .select("id,status,proposta_payload,approved_at,approved_by,created_at")
        .eq("card_id", card.id)
        .filter("proposta_payload->>tool", "eq", "responder_cliente")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data ?? null) as TodoRow | null;
    },
  });
  useRealtimeInvalidate("todos", ["resposta-todo", card.id], `card_id=eq.${card.id}`);

  const respostaPendente = respostaTodo?.status === "pendente";

  return (
    <div className="flex h-full flex-col">
      {/* Tabs — underline profissional */}
      <nav className="flex shrink-0 gap-1 border-b border-rule bg-paper px-2" role="tablist">
        {([
          { id: "mensagens", label: "Mensagens" },
          { id: "resposta", label: "Resposta" },
          { id: "eventos", label: "Eventos" },
          { id: "ssw", label: "Histórico SSW" },
        ] as const).map((t) => {
          const active = aba === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => setAba(t.id)}
              className={cn(
                "relative -mb-px border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
                active
                  ? "border-sal text-ink"
                  : "border-transparent text-ink-mute hover:text-ink",
              )}
            >
              {t.label}
              {t.id === "resposta" && respostaPendente && !active && (
                <span className="absolute right-0.5 top-1.5 inline-block h-1.5 w-1.5 rounded-full bg-sal animate-pulse-dot" />
              )}
            </button>
          );
        })}
      </nav>

      {aba === "mensagens" && <MessagesTab card={card} />}
      {aba === "resposta" && (
        <RespostaTab card={card} onGotoMensagens={() => setAba("mensagens")} />
      )}
      {aba === "eventos" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <HistoricoEventosCard cardId={card.id} />
        </div>
      )}
      {aba === "ssw" && (
        <div id="historico-ssw" className="min-h-0 flex-1 overflow-y-auto p-5">
          <SswTab card={card} />
        </div>
      )}
    </div>
  );
}

/* ---------------- Mensagens ---------------- */
/*
 * Esta seção foi reescrita 2026-06-11 — só apresentação.
 * Não mexe em queries, hooks, contratos ou lógica de negócio.
 *
 * Campos que faltam pra visão "ideal" da spec, e que NÃO estão nos dados que
 * o componente já recebe hoje (não foram inventados / não foram buscados de
 * fonte nova — listados aqui pra eventual incremento futuro):
 *   - inbound: raw_payload (from/to/cc/subject) — hoje só `remetente` e `conteudo`
 *   - outbound: subject, to_email, cc, from_email, corpo_renderizado — hoje o
 *     "enviado" vem de card_events (payload.texto), sem assunto nem destinatário
 *   - anexos outbound (email_anexos com origem='outbound') — hoje só inbound
 */

interface ThreadItem {
  id: string;
  side: "left" | "right";
  channel: CanalOrigem | null;
  senderEmail: string;
  senderName: string;
  isSal: boolean;
  text: string;
  timestamp: string;
}

interface InboundAnexo {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  message_inbox_id: string;
  storage_path: string;
}

function iconForMime(mime: string | null | undefined): string {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "IMG";
  if (m.includes("pdf")) return "PDF";
  if (m.includes("excel") || m.includes("spreadsheet") || m.endsWith("/csv")) return "XLS";
  if (m.includes("word") || m.includes("msword") || m.includes("officedocument.wordprocessing"))
    return "DOC";
  if (m.startsWith("text/")) return "TXT";
  return "FILE";
}

function formatBytes(b: number | null | undefined): string {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

async function abrirAnexoInbound(path: string) {
  if (!supabase) return;
  const { data, error } = await supabase.storage
    .from("email_anexos")
    .createSignedUrl(path, 60);
  if (error || !data?.signedUrl) {
    toast.error("Não consegui gerar link", { description: error?.message });
    return;
  }
  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}

/* ---------- parsing de corpo (front, sobre texto cru) ---------- */

function parseEmailAddress(raw: string): { name: string; email: string } {
  if (!raw) return { name: "—", email: "" };
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<\s*([^>]+)\s*>\s*$/);
  if (m && m[2]) {
    const name = m[1].trim();
    const email = m[2].trim();
    return { name: name || nameFromLocalPart(email), email };
  }
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return { name: nameFromLocalPart(trimmed), email: trimmed };
  return { name: trimmed || "—", email: "" };
}

function nameFromLocalPart(email: string): string {
  const local = (email.split("@")[0] ?? email).replace(/[+].*/, "");
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

function initialsOf(name: string, email: string): string {
  const base = (name && name !== "—" ? name : email.split("@")[0] ?? "").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function isSalExpressEmail(email: string): boolean {
  return /@salexpress\.com\.br/i.test(email);
}

interface ParsedBody {
  main: string;
  quoted: string | null;
  signature: string | null;
  quotedCount: number;
}

const QUOTE_START_PATTERNS: RegExp[] = [
  /^\s*-{2,}\s*Mensagem original\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*Em\s.{1,80}\bescreveu:\s*$/i,
  /^\s*On\s.{1,80}\bwrote:\s*$/i,
  /^\s*De:\s.+/i,
  /^\s*From:\s.+/i,
  /^\s*>+\s?.*/,
];

const SIGNATURE_START_PATTERNS: RegExp[] = [
  /^\s*Atenciosamente[,!.]?\s*$/i,
  /^\s*Cordialmente[,!.]?\s*$/i,
  /^\s*Att\.?[,!]?\s*$/i,
  /^\s*Abs\.?[,!]?\s*$/i,
  /^\s*Sds\.?[,!]?\s*$/i,
  /^\s*Obrigad[oa][,!.]?\s*$/i,
  /^\s*Best regards[,!.]?\s*$/i,
  /^\s*Regards[,!.]?\s*$/i,
  /^\s*Thanks[,!.]?\s*$/i,
  /^\s*--\s*$/,
  /^\s*AVISO DE CONFIDENCIALIDADE/i,
  /^\s*Esta mensagem.*confidencial/i,
  /^\s*This e-?mail.*confidential/i,
];

function parseBody(raw: string): ParsedBody {
  if (!raw) return { main: "", quoted: null, signature: null, quotedCount: 0 };
  let s = raw.replace(/\r\n/g, "\n");
  // Remove tags técnicas
  s = s.replace(/\[cid:[^\]\n]+\]/gi, "");
  // Limpa "mailto:" mantendo o e-mail legível
  s = s.replace(/mailto:([^\s>)\]]+)/gi, "$1");

  const lines = s.split("\n");
  let quoteStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (QUOTE_START_PATTERNS.some((re) => re.test(lines[i]))) {
      quoteStart = i;
      break;
    }
  }

  const beforeQuote = quoteStart >= 0 ? lines.slice(0, quoteStart) : lines;
  const quotedRaw = quoteStart >= 0 ? lines.slice(quoteStart).join("\n").trim() : null;

  let sigStart = -1;
  for (let i = 0; i < beforeQuote.length; i++) {
    if (SIGNATURE_START_PATTERNS.some((re) => re.test(beforeQuote[i]))) {
      sigStart = i;
      break;
    }
  }

  const mainLines = sigStart >= 0 ? beforeQuote.slice(0, sigStart) : beforeQuote;
  const sigLines = sigStart >= 0 ? beforeQuote.slice(sigStart) : [];

  const main = mainLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const signature = sigLines.length ? sigLines.join("\n").trim() : null;

  let quotedCount = 0;
  if (quotedRaw) {
    const m = quotedRaw.match(/(^|\n)\s*(De:|From:|Em\s.+escreveu:|On\s.+wrote:|-{2,}\s*Mensagem)/gi);
    quotedCount = m ? m.length : 1;
  }

  return { main: main || "(sem texto)", quoted: quotedRaw, signature, quotedCount };
}

function AnexosInboundBlock({ anexos }: { anexos: InboundAnexo[] }) {
  if (!anexos.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {anexos.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => abrirAnexoInbound(a.storage_path)}
          className="inline-flex items-center gap-1.5 border border-ink/20 bg-paper px-2 py-1 font-mono text-[10px] text-ink hover:border-ink"
          title="Baixar"
        >
          <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-mute">
            {iconForMime(a.mime_type)}
          </span>
          <span className="max-w-[180px] truncate">{a.filename}</span>
          {a.size_bytes != null && (
            <span className="text-ink/40">· {formatBytes(a.size_bytes)}</span>
          )}
          <span className="text-ink-soft">↓</span>
        </button>
      ))}
    </div>
  );
}

export interface EmailThreadMessageWithThread extends EmailThreadMessage {
  threadId: string | null;
}

function MessagesTab({ card }: { card: CardRow }) {
  const { data, isLoading } = useQuery({
    queryKey: ["card-thread", card.id],
    queryFn: async () => {
      if (!supabase)
        return {
          received: [] as Array<MessageInboxRow & { raw_payload?: any }>,
          sent: [] as CardEventRow[],
          outbound: [] as Array<{ sent_at: string; gmail_thread_id: string | null }>,
          anexosByMsg: {} as Record<string, InboundAnexo[]>,
        };
      const [m, e, o] = await Promise.all([
        supabase
          .from("messages_inbox")
          .select(
            "id,card_id,canal,remetente,conteudo,recebido_em,processed_at,processing_status,raw_payload",
          )
          .eq("card_id", card.id)
          .order("recebido_em", { ascending: true }),
        supabase
          .from("card_events")
          .select("id,card_id,event_type,event_version,payload,actor_type,actor_id,created_at")
          .eq("card_id", card.id)
          .in("event_type", SENT_EVENT_TYPES)
          .order("created_at", { ascending: true }),
        supabase
          .from("cards_emails_outbound")
          .select("sent_at,gmail_thread_id")
          .eq("card_id", card.id)
          .order("sent_at", { ascending: true }),
      ]);
      if (m.error) throw m.error;
      if (e.error) throw e.error;
      const received = (m.data ?? []) as Array<MessageInboxRow & { raw_payload?: any }>;
      const sent = (e.data ?? []) as CardEventRow[];
      const outbound = (o.data ?? []) as Array<{
        sent_at: string;
        gmail_thread_id: string | null;
      }>;

      const msgIds = received.map((r) => r.id);
      const anexosByMsg: Record<string, InboundAnexo[]> = {};
      if (msgIds.length) {
        const { data: ax } = await supabase
          .from("email_anexos")
          .select("id, filename, mime_type, size_bytes, message_inbox_id, storage_path")
          .in("message_inbox_id", msgIds)
          .eq("origem", "inbound");
        ((ax ?? []) as InboundAnexo[]).forEach((a) => {
          if (!a.message_inbox_id) return;
          (anexosByMsg[a.message_inbox_id] ??= []).push(a);
        });
      }
      return { received, sent, outbound, anexosByMsg };
    },
    enabled: !!supabase,
  });

  useRealtimeInvalidate("messages_inbox", ["card-thread", card.id], `card_id=eq.${card.id}`);
  useRealtimeInvalidate("card_events", ["card-thread", card.id], `card_id=eq.${card.id}`);

  /* Mensagens renderizadas pelo EmailThread (balões). threadId é só metadado
   * de agrupamento visual por tratativa Gmail.
   * Inbound: messages_inbox.raw_payload.gmail_thread_id
   * Outbound: cards_emails_outbound.gmail_thread_id (matched por timestamp)
   */
  const emailMessages: EmailThreadMessageWithThread[] = useMemo(() => {
    const out: EmailThreadMessageWithThread[] = [];

    (data?.received ?? []).forEach((m) => {
      const { name, email } = parseEmailAddress(m.remetente);
      const anexos = (data?.anexosByMsg?.[m.id] ?? []).map((a) => ({
        name: a.filename,
        size: a.size_bytes,
        url: null,
        storagePath: a.storage_path,
        onOpen: () => abrirAnexoInbound(a.storage_path),
      }));
      const rp = (m.raw_payload ?? {}) as Record<string, any>;
      const tid =
        (rp.gmail_thread_id as string | undefined) ??
        (rp.thread_id as string | undefined) ??
        (rp.threadId as string | undefined) ??
        null;
      out.push({
        id: `m-${m.id}`,
        fromName: name,
        fromEmail: email,
        body: m.conteudo ?? "",
        date: m.recebido_em,
        attachments: anexos,
        side: isSalExpressEmail(email) ? "sal" : "cli",
        threadId: tid,
      });
    });

    const outboundRows = data?.outbound ?? [];
    const matchThread = (iso: string): string | null => {
      if (!outboundRows.length) return null;
      const t = new Date(iso).getTime();
      let best: { tid: string | null; diff: number } | null = null;
      for (const o of outboundRows) {
        if (!o.sent_at) continue;
        const diff = Math.abs(new Date(o.sent_at).getTime() - t);
        if (!best || diff < best.diff) best = { tid: o.gmail_thread_id, diff };
      }
      // tolera até 10 min entre o evento e o registro outbound
      if (best && best.diff <= 10 * 60 * 1000) return best.tid;
      return null;
    };

    (data?.sent ?? []).forEach((e) => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      if (e.event_type === "AcaoExecutada" && payload["tipo"] !== "enviar_mensagem") return;
      const text =
        (payload["texto"] as string) ??
        (payload["texto_final"] as string) ??
        (payload["mensagem"] as string) ??
        "";
      if (!text) return;
      const fromRaw =
        (payload["from"] as string) ??
        (payload["from_email"] as string) ??
        (e.actor_id as string) ??
        "relacionamento@salexpress.com.br";
      const { name, email } = parseEmailAddress(fromRaw);
      const tid =
        (payload["gmail_thread_id"] as string | undefined) ??
        (payload["thread_id"] as string | undefined) ??
        matchThread(e.created_at);
      out.push({
        id: `e-${e.id}`,
        fromName: name || "Sal·Express",
        fromEmail: email || "relacionamento@salexpress.com.br",
        body: text,
        date: e.created_at,
        side: "sal",
        threadId: tid,
      });
    });
    return out;
  }, [data]);

  const tratativasQ = useTratativasEmail(card.id);
  const tData = tratativasQ.data ?? null;
  const multiplas = !!tData?.multiplas_tratativas;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto bg-paper p-5">
        <PainelTratativaDetectada cardId={card.id} nf={card.nf} />
        {isLoading ? (
          <div className="text-center font-display text-[12px] italic text-ink-soft">
            Carregando…
          </div>
        ) : multiplas && tData ? (
          <TratativasEmailMultiplas
            data={tData}
            messages={emailMessages}
            escolhendo={tratativasQ.escolher.isPending}
            onEscolher={(threadId) => tratativasQ.escolher.mutate(threadId)}
          />
        ) : (
          <EmailThread messages={emailMessages} />
        )}
      </div>
    </div>
  );
}

function DateSeparator({ iso }: { iso: string }) {
  const label = format(new Date(iso), "EEEE, dd 'DE' MMMM 'DE' yyyy", { locale: ptBR })
    .toUpperCase();
  return (
    <div className="my-4 flex items-center gap-3">
      <div className="h-px flex-1 bg-ink/15" />
      <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-ink-soft">
        {label}
      </span>
      <div className="h-px flex-1 bg-ink/15" />
    </div>
  );
}

function Avatar({ initials, isSal }: { initials: string; isSal: boolean }) {
  return (
    <div
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center border font-mono text-[10px] font-bold uppercase",
        isSal
          ? "border-blue-700 bg-blue-100 text-blue-800"
          : "border-amber-700 bg-amber-100 text-amber-900",
      )}
    >
      {initials}
    </div>
  );
}

function Bubble({
  item,
  anexos = [],
  isLatest,
}: {
  item: ThreadItem;
  anexos?: InboundAnexo[];
  isLatest: boolean;
}) {
  const isRight = item.side === "right";
  const parsed = useMemo(() => parseBody(item.text), [item.text]);
  const [showQuoted, setShowQuoted] = useState(false);
  const [showSig, setShowSig] = useState(false);

  const initials = initialsOf(item.senderName, item.senderEmail);
  const relative = relativeShort(item.timestamp);
  const absolute = format(new Date(item.timestamp), "dd/MM · HH:mm", { locale: ptBR });

  const badgeLabel = isRight ? "SAL·EXPRESS · RELACIONAMENTO" : "CLIENTE";
  const badgeCls = isRight
    ? "bg-blue-700 text-paper"
    : "bg-amber-600 text-paper";
  const bubbleCls = isRight
    ? "border-blue-200 bg-blue-50"
    : "border-amber-200 bg-amber-50";

  return (
    <div className={cn("flex gap-2", isRight ? "flex-row-reverse" : "flex-row")}>
      <Avatar initials={initials} isSal={isRight} />
      <div className={cn("flex max-w-[78%] flex-col", isRight ? "items-end" : "items-start")}>
        <div
          className={cn(
            "mb-1 flex flex-wrap items-center gap-1.5",
            isRight ? "justify-end" : "justify-start",
          )}
        >
          {isLatest && (
            <span className="inline-flex items-center gap-1 border border-sal bg-sal-tint px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-widest text-sal-deep">
              <span className="h-1.5 w-1.5 rounded-full bg-sal" />
              ÚLTIMA RESPOSTA
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-widest",
              badgeCls,
            )}
          >
            {badgeLabel}
          </span>
        </div>

        <div className={cn("w-full border px-3 py-2", bubbleCls)}>
          <div
            className={cn(
              "mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5",
              isRight ? "justify-end" : "justify-start",
            )}
          >
            <span className="font-sans text-[12px] font-semibold text-ink">
              {item.senderName}
            </span>
            {item.senderEmail && (
              <span className="font-mono text-[10px] text-ink-soft">
                &lt;{item.senderEmail}&gt;
              </span>
            )}
          </div>

          <div
            className={cn(
              "mb-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[9px] uppercase tracking-widest text-ink-soft",
              isRight ? "justify-end" : "justify-start",
            )}
          >
            <span>{canalIcon(item.channel)} {item.channel ?? "email"}</span>
            <span>·</span>
            <span title={absolute}>{relative}</span>
            <span className="text-ink/40">({absolute})</span>
          </div>

          <p className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-ink">
            {parsed.main}
          </p>

          {parsed.signature && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowSig((v) => !v)}
                className="font-mono text-[9px] uppercase tracking-widest text-ink-soft hover:text-ink"
              >
                {showSig ? "▴ ocultar assinatura" : "▾ mostrar assinatura"}
              </button>
              {showSig && (
                <pre className="mt-1 whitespace-pre-wrap border-l-2 border-ink/15 pl-2 font-sans text-[11px] leading-snug text-ink-soft">
                  {parsed.signature}
                </pre>
              )}
            </div>
          )}

          {parsed.quoted && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowQuoted((v) => !v)}
                className="font-mono text-[9px] uppercase tracking-widest text-ink-soft hover:text-ink"
              >
                {showQuoted
                  ? "▴ ocultar histórico citado"
                  : `▾ mostrar histórico citado${
                      parsed.quotedCount > 1 ? ` (${parsed.quotedCount} mensagens)` : ""
                    }`}
              </button>
              {showQuoted && (
                <pre className="mt-1 whitespace-pre-wrap border-l-2 border-ink/15 pl-2 font-sans text-[11px] leading-snug text-ink-soft">
                  {parsed.quoted}
                </pre>
              )}
            </div>
          )}

          {!isRight && anexos.length > 0 && <AnexosInboundBlock anexos={anexos} />}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Resposta (gerador IA) ---------------- */

interface RespostaPayload {
  tool?: "responder_cliente";
  args?: { canal?: CanalOrigem; destinatario?: string; subject?: string };
  texto_sugerido?: string;
  texto_final?: string;
  confianca?: "alta" | "media" | "baixa";
  rationale?: string;
  modelo_usado?: string;
  versao_prompt?: string;
  gerado_em?: string;
  editado_em?: string;
}

function ConfiancaPill({ nivel }: { nivel: "alta" | "media" | "baixa" }) {
  const map = {
    alta: { label: "Confiança alta", cls: "bg-good/15 border-good text-good" },
    media: { label: "Confiança média", cls: "bg-warn/20 border-warn text-ink" },
    baixa: { label: "Confiança baixa", cls: "bg-sal-tint border-sal text-sal-deep" },
  } as const;
  const c = map[nivel];
  return (
    <span
      className={cn(
        "inline-flex items-center border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest",
        c.cls,
      )}
    >
      {c.label}
    </span>
  );
}

function AnalogClock() {
  return (
    <span className="inline-flex h-3 w-3 items-center justify-center rounded-full border border-current">
      <span className="block h-1.5 w-px origin-bottom bg-current animate-analog-tick" />
    </span>
  );
}

function FlagBanner() {
  if (!ENVIO_DESABILITADO) return null;
  return (
    <div className="flex items-start gap-3 rounded-md border border-warn/50 bg-warn/10 px-3 py-2.5">
      <span className="font-mono text-[15px] font-bold leading-none text-warn">!</span>
      <div className="flex-1 font-display text-[12px] italic leading-snug text-ink">
        <strong className="font-sans not-italic font-semibold text-ink">
          Modo preparação ativo.
        </strong>{" "}
        Clicar Enviar registra a intenção mas <em>não envia o email</em>.
      </div>
    </div>
  );
}

function diasUteisEntre(from: Date, to: Date): number {
  if (to <= from) return 0;
  let count = 0;
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cur < end) {
    cur.setDate(cur.getDate() + 1);
    const d = cur.getDay();
    if (d !== 0 && d !== 6) count++;
  }
  return count;
}

function CobrancaClienteBlock({ card }: { card: CardRow }) {
  const { operador } = useAuth();
  const qc = useQueryClient();

  const { data: ultimoOutbound } = useQuery({
    queryKey: ["ultimo-outbound", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data } = await supabase!
        .from("cards_emails_outbound")
        .select("sent_at,to_email")
        .eq("card_id", card.id)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data ?? null) as { sent_at: string; to_email: string | null } | null;
    },
  });

  const { data: cobrancaEvents } = useQuery({
    queryKey: ["cobranca-events", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data } = await supabase!
        .from("card_events")
        .select("at, payload, actor_type")
        .eq("card_id", card.id)
        .eq("event_type", "CobrancaClienteEmailEnviada")
        .order("at", { ascending: false });
      return (data ?? []) as Array<{
        at: string;
        actor_type: string | null;
        payload: { modo?: string; destinatario?: string } | null;
      }>;
    },
  });
  useRealtimeInvalidate("card_events", ["cobranca-events", card.id], `card_id=eq.${card.id}`);

  const cardAny = card as unknown as {
    cobranca_cliente_emails_enviados?: number | null;
    cobranca_cliente_ultima_em?: string | null;
  };
  const countAuto = cardAny.cobranca_cliente_emails_enviados ?? 0;
  const ultimaCobrancaEm = cardAny.cobranca_cliente_ultima_em ?? null;

  const dias = ultimoOutbound?.sent_at
    ? diasUteisEntre(new Date(ultimoOutbound.sent_at), new Date())
    : null;

  const corDias =
    dias == null
      ? "text-ink-soft"
      : dias >= 8
      ? "text-rose-700"
      : dias >= 4
      ? "text-amber-700"
      : "text-ink-soft";

  const enviarCobranca = useMutation({
    mutationFn: async () => {
      if (!supabase) throw new Error("Sem conexão");
      const { data, error } = await supabase.functions.invoke("cobrar-cliente-aguardando", {
        body: { card_id: card.id, modo: "manual" },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Erro ao enviar cobrança");
      return data as { ok: true; destinatario?: string };
    },
    onSuccess: (data) => {
      toast.success(`Cobrança enviada${data?.destinatario ? ` pra ${data.destinatario}` : ""}`);
      qc.invalidateQueries({ queryKey: ["cobranca-events", card.id] });
      qc.invalidateQueries({ queryKey: ["card", card.id] });
      qc.invalidateQueries({ queryKey: ["card-events", card.id] });
    },
    onError: (e: Error) => toast.error("Falha ao enviar cobrança", { description: e.message }),
  });

  let textoCount: string;
  if (countAuto === 0) {
    textoCount = "Nenhuma cobrança automática enviada ainda.";
  } else if (countAuto === 1) {
    const dt = ultimaCobrancaEm
      ? format(new Date(ultimaCobrancaEm), "dd/MM", { locale: ptBR })
      : "—";
    textoCount = `1 cobrança automática enviada em ${dt}.`;
  } else {
    textoCount = `${countAuto} cobranças automáticas enviadas — máximo atingido. Operador pode enviar manual.`;
  }

  return (
    <div className="border border-rule-strong bg-paper-deep p-3 space-y-3">
      <div>
        <div className="font-mono text-[9px] uppercase tracking-widest text-ink-soft mb-1">
          aguardando cliente
        </div>
        {dias != null ? (
          <p className="font-display text-[13px] text-ink">
            Cliente sem retorno há{" "}
            <strong className={cn("font-sans font-bold", corDias)}>{dias} dias úteis</strong>{" "}
            desde o último email enviado.
          </p>
        ) : (
          <p className="font-display text-[13px] italic text-ink-soft">
            Sem email enviado ainda nesse card.
          </p>
        )}
      </div>

      <div className="border-t border-rule pt-2">
        <div className="font-mono text-[9px] uppercase tracking-widest text-ink-soft mb-1">
          cobranças
        </div>
        <p className="font-display text-[12px] text-ink">{textoCount}</p>
        {(cobrancaEvents?.length ?? 0) > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {cobrancaEvents!.map((ev, i) => (
              <li
                key={i}
                className="font-mono text-[10px] text-ink-soft flex items-center gap-2"
              >
                <span>•</span>
                <span>{format(new Date(ev.at), "dd/MM HH:mm", { locale: ptBR })}</span>
                <span className="uppercase tracking-widest">
                  {ev.payload?.modo === "manual" ? "manual" : "automática"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        onClick={() => enviarCobranca.mutate()}
        disabled={enviarCobranca.isPending || operador?.pode_executar === false}
        className="btn-flat w-full bg-sal text-paper disabled:opacity-50"
        title='Envia: "{nome}, estamos aguardando um retorno para finalizarmos a tratativa. Obrigado."'
      >
        {enviarCobranca.isPending ? "Enviando…" : "Enviar cobrança agora"}
      </button>
    </div>
  );
}

function PointerTratativaOutraThread({
  cardId,
  onGoto,
}: {
  cardId: string;
  onGoto: () => void;
}) {
  const { data } = useQuery({
    queryKey: ["v_email_preexistente", cardId],
    enabled: !!cardId && !!supabase,
    queryFn: async () => {
      const { data } = await supabase!
        .from("v_email_preexistente")
        .select("contexto")
        .eq("card_id", cardId)
        .maybeSingle();
      return (data ?? null) as { contexto: "nascimento" | "card_em_espera" } | null;
    },
  });
  if (!data || data.contexto !== "card_em_espera") return null;
  return (
    <button
      type="button"
      onClick={onGoto}
      className="flex w-full items-center justify-between gap-3 border-l-[3px] border-amber-500 bg-amber-50 px-3 py-2 text-left text-[12px] text-amber-900 hover:bg-amber-100"
    >
      <span className="font-display">
        Há uma tratativa detectada em outra thread — veja na aba{" "}
        <strong className="font-mono uppercase tracking-widest">Mensagens</strong>.
      </span>
      <span className="font-mono text-[10px] uppercase tracking-widest text-amber-700">
        Abrir →
      </span>
    </button>
  );
}

function RespostaTab({
  card,
  onGotoMensagens,
}: {
  card: CardRow;
  onGotoMensagens: () => void;
}) {
  const { operador, user } = useAuth();
  const qc = useQueryClient();

  const [textoEditavel, setTextoEditavel] = useState<string>("");
  const [hidratado, setHidratado] = useState(false);
  const [ccSelecionados, setCcSelecionados] = useState<string[]>([]);
  const [anexos, setAnexos] = useState<AnexoUploaded[]>([]);
  const [uploadingAnexo, setUploadingAnexo] = useState(false);

  // CNPJ pagador do card (lido direto do agent_state)
  const { data: cardCtx } = useQuery({
    queryKey: ["aba-resposta-card-ctx", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data } = await supabase!
        .from("cards")
        .select("agent_state")
        .eq("id", card.id)
        .maybeSingle();
      return data;
    },
  });
  const cnpjPagador = (cardCtx?.agent_state as Record<string, unknown> | null)?.cnpj_pagador as
    | string
    | undefined;
  const cnpjLimpo = cnpjPagador?.replace(/\D/g, "") ?? null;
  const remetenteCru = remetenteCruDoAgentState(cardCtx?.agent_state);

  // Contatos email do cliente — multi-select de Cc
  const { data: contatos } = useQuery({
    queryKey: ["contatos-email-aba-resposta", cnpjLimpo, remetenteCru],
    enabled: !!supabase && !!cnpjLimpo,
    queryFn: async () => {
      const { data } = await supabase!
        .from("contatos_cliente")
        .select("identificador, nome_pessoa, cargo, ordem, cnpj_remetente")
        .eq("documento_cliente", cnpjLimpo!)
        .eq("tipo", "email")
        .eq("ativo", true)
        .or(remetenteCru ? `cnpj_remetente.is.null,cnpj_remetente.eq.${remetenteCru}` : "cnpj_remetente.is.null")
        .order("cnpj_remetente", { ascending: false, nullsFirst: false })
        .order("ordem", { nullsFirst: false });
      return (data ?? []) as Array<{
        identificador: string;
        nome_pessoa: string | null;
        cargo: string | null;
        ordem: number | null;
        cnpj_remetente: string | null;
      }>;
    },
  });

  function toggleCc(email: string) {
    setCcSelecionados((prev) =>
      prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email],
    );
  }

  // Última sugestão do redator (pendente preferencial; senão a mais recente)
  const { data: todoResposta, isLoading: loadingTodo } = useQuery({
    queryKey: ["resposta-todo", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data } = await supabase!
        .from("todos")
        .select("*")
        .eq("card_id", card.id)
        .filter("proposta_payload->>tool", "eq", "responder_cliente")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data ?? null) as TodoRow | null;
    },
  });

  // Última mensagem inbound (origem da thread)
  const { data: ultimaInbound, isLoading: loadingInbound } = useQuery({
    queryKey: ["ultima-msg-inbound", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data } = await supabase!
        .from("messages_inbox")
        .select("*")
        .eq("card_id", card.id)
        .eq("canal", "email")
        .order("recebido_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data ?? null) as (MessageInboxRow & { raw_payload?: any }) | null;
    },
  });

  const payload = (todoResposta?.proposta_payload ?? {}) as RespostaPayload;
  const textoSugerido = payload.texto_sugerido ?? "";

  // Pré-preenche composer ao carregar sugestão
  useEffect(() => {
    if (!hidratado && textoSugerido) {
      setTextoEditavel(textoSugerido);
      setHidratado(true);
    }
  }, [textoSugerido, hidratado]);

  const editado = hidratado && textoEditavel !== textoSugerido;

  const regenerar = useMutation({
    mutationFn: async () => {
      if (!supabase) throw new Error("Sem conexão");
      const { error } = await supabase.functions.invoke("redator", {
        body: { card_id: card.id, force: true },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Sugestão atualizada pela IA.");
      setHidratado(false);
      qc.invalidateQueries({ queryKey: ["resposta-todo", card.id] });
    },
    onError: (e: Error) => toast.error("Falha ao regenerar", { description: e.message }),
  });



  const enviar = useMutation({
    mutationFn: async () => {
      if (!supabase) throw new Error("Sem conexão");
      if (!ultimaInbound) throw new Error("Sem mensagem inbound nesse card pra responder.");
      const final = textoEditavel.trim();
      if (final.length < 5) throw new Error("Texto muito curto");
      const { data, error } = await supabase.functions.invoke("responder-email-cliente", {
        body: {
          card_id: card.id,
          texto: final,
          mensagem_origem_id: ultimaInbound.id,
          cc: ccSelecionados,
          anexos_ids: anexos.map((a) => a.anexo_id),
        },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Erro ao enviar");
      return data as { ok: true; to?: string; cc?: string[] };
    },
    onSuccess: (data) => {
      const ccMsg = (data?.cc?.length ?? 0) > 0 ? ` (cc: ${data!.cc!.length})` : "";
      toast.success(`Resposta enviada${data?.to ? ` pra ${data.to}` : ""}${ccMsg}`);
      setTextoEditavel("");
      setHidratado(false);
      setCcSelecionados([]);
      setAnexos([]);
      qc.invalidateQueries({ queryKey: ["cards"] });
      qc.invalidateQueries({ queryKey: ["card", card.id] });
      qc.invalidateQueries({ queryKey: ["card-thread", card.id] });
      qc.invalidateQueries({ queryKey: ["card-events", card.id] });
      qc.invalidateQueries({ queryKey: ["ultima-msg-inbound", card.id] });
      qc.invalidateQueries({ queryKey: ["resposta-todo", card.id] });
    },
    onError: (e: Error) => toast.error("Falha ao enviar", { description: e.message }),
  });

  const isLoading = loadingTodo || loadingInbound;

  if (isLoading) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="flex items-center gap-2 font-display text-[13px] italic text-ink-soft">
          <AnalogClock /> Carregando…
        </div>
      </div>
    );
  }

  if (!ultimaInbound) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mb-4">
          <PointerTratativaOutraThread cardId={card.id} onGoto={onGotoMensagens} />
        </div>
        <div className="flex flex-col items-center border border-dashed border-rule-strong p-8 text-center">
          <span className="mb-3 font-display text-[32px] text-ink-mute">◇</span>
          <p className="font-display text-[13px] italic text-ink-soft">
            Nenhuma mensagem do cliente nesse card pra responder.
          </p>
        </div>
      </div>
    );
  }

  const subjectOriginal =
    (ultimaInbound.raw_payload as any)?.Subject ??
    (ultimaInbound.raw_payload as any)?.subject ??
    "Sua mensagem";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="space-y-4">
        <PointerTratativaOutraThread cardId={card.id} onGoto={onGotoMensagens} />
        {card.state === "AGUARDANDO_CLIENTE" && !card.cliente_respondeu_em && (
          <CobrancaClienteBlock card={card} />
        )}
        {/* Cabeçalho */}
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h3 className="font-display text-[18px] font-semibold text-ink">
              Resposta ao cliente
            </h3>
            {payload.confianca && <ConfiancaPill nivel={payload.confianca} />}
          </div>
          <button
            onClick={() => regenerar.mutate()}
            disabled={regenerar.isPending || operador?.pode_executar === false}
            className="font-mono text-[9px] uppercase tracking-widest text-ink-soft hover:text-sal disabled:opacity-40"
            title="Pede pra IA gerar uma nova sugestão (sobrescreve atual)"
          >
            {regenerar.isPending ? <AnalogClock /> : "↻"} Regerar sugestão
          </button>
        </div>

        {/* Contexto: a quem vai a resposta */}
        <div className="rounded-md border-l-2 border-rule-strong bg-surface-alt px-3 py-2">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-widest text-ink-soft">
            respondendo
          </div>
          <div className="font-display text-[13px] text-ink">
            <span className="font-mono text-[11px] text-ink-soft">Para:</span>{" "}
            <span className="font-mono text-[12px]">{ultimaInbound.remetente}</span>
            <br />
            <span className="font-mono text-[11px] text-ink-soft">Assunto:</span>{" "}
            <span className="italic">Re: {subjectOriginal}</span>
          </div>
        </div>

        {/* Multi-select Cc — outros contatos cadastrados do cliente */}
        {(() => {
          const remetenteOrig = (ultimaInbound.remetente ?? "").toLowerCase();
          const ccCandidatos = (contatos ?? []).filter(
            (c) => c.identificador.toLowerCase() !== remetenteOrig,
          );
          if (ccCandidatos.length === 0) return null;
          return (
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                Copiar também (cc) — opcional
                <span className="ml-2 font-display text-[10px] italic normal-case tracking-normal text-ink-soft/70">
                  marque outros contatos do cliente. 1 email só, mesma thread.
                </span>
              </label>
              <div className="divide-y divide-rule border border-rule-strong bg-paper">
                {ccCandidatos.map((c) => {
                  const checked = ccSelecionados.includes(c.identificador);
                  return (
                    <label
                      key={c.identificador}
                      className="flex cursor-pointer items-start gap-2 px-2 py-1.5 hover:bg-paper-deep"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCc(c.identificador)}
                        className="mt-0.5 h-3.5 w-3.5 accent-sal"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[11px] text-ink">
                          {c.identificador}
                        </div>
                        {(c.nome_pessoa || c.cargo || c.cnpj_remetente) && (
                          <div className="truncate font-display text-[10px] italic text-ink-soft">
                            {[c.cnpj_remetente ? "📌 contato deste remetente" : null, c.nome_pessoa, c.cargo].filter(Boolean).join(" • ")}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
              {ccSelecionados.length > 0 && (
                <div className="mt-1 font-mono text-[9px] uppercase tracking-widest text-ink-soft">
                  {ccSelecionados.length} contato(s) em cópia
                </div>
              )}
            </div>
          );
        })()}

        {/* Composer */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              Sua resposta
              {textoSugerido && (
                <span className="ml-2 font-display text-[11px] italic text-ink-soft/70">
                  ✦ pré-preenchida pela IA — edite à vontade
                </span>
              )}
            </label>
            {editado && (
              <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-warn">
                Editado
              </span>
            )}
          </div>
          <textarea
            value={textoEditavel}
            onChange={(e) => setTextoEditavel(e.target.value)}
            rows={12}
            placeholder="Escreva sua resposta ou aguarde a sugestão da IA…"
            className="w-full resize-y rounded-md border border-rule-strong bg-surface p-4 text-[14px] leading-relaxed text-ink focus:border-sal focus:outline-none"
          />
        </div>

        {payload.rationale && (
          <details className="border border-rule bg-paper-deep p-2.5 text-[12px]">
            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              Por que essa resposta
            </summary>
            <p className="mt-1.5 font-display italic leading-snug text-ink">
              {payload.rationale}
            </p>
          </details>
        )}

        <FlagBanner />

        <AnexosUploader
          cardId={card.id}
          anexos={anexos}
          onChange={setAnexos}
          uploading={uploadingAnexo}
          setUploading={setUploadingAnexo}
          disabled={enviar.isPending}
        />

        {/* Ações */}
        <div className="flex items-end justify-between gap-3 border-t border-rule pt-3">
          <p className="font-display text-[11px] italic leading-snug text-ink-soft">
            Resposta sai do seu Gmail (
            <span className="font-mono not-italic text-ink">
              {user?.email ?? operador?.email ?? "—"}
            </span>
            ) e mantém a thread original. Cliente recebe na mesma conversa.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => enviar.mutate()}
              disabled={enviar.isPending || uploadingAnexo || textoEditavel.trim().length < 5}
              className="btn-flat whitespace-nowrap bg-sal text-paper"
            >
              {enviar.isPending ? "Enviando…" : "Enviar resposta →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Eventos (timeline editorial) ---------------- */

const EVENT_RENDER: Record<
  string,
  { icon: string; label: string; tone: "neutral" | "good" | "warn" | "crit" | "info" }
> = {
  MensagemAnexada: { icon: "◐", label: "Mensagem anexada", tone: "neutral" },
  RespostaSugerida: { icon: "✎", label: "Sugestão de resposta gerada", tone: "info" },
  RespostaEnviadaSolicitada: { icon: "↗", label: "Envio solicitado", tone: "info" },
  RespostaEnviada: { icon: "✓", label: "Resposta enviada", tone: "good" },
  RespostaEnvioBloqueadoPorFlag: {
    icon: "◌",
    label: "Envio bloqueado (modo preparação)",
    tone: "warn",
  },
  RespostaEnvioFalhou: { icon: "✕", label: "Falha no envio", tone: "crit" },
  AcaoPropostaPeloAgente: { icon: "◆", label: "Ação proposta pelo agente", tone: "info" },
  AprovacaoOperador: { icon: "✓", label: "Aprovado pelo operador", tone: "good" },
  AutoAprovacaoPermitida: { icon: "◆", label: "Auto-aprovação", tone: "neutral" },
  RejeicaoOperador: { icon: "✕", label: "Rejeitado pelo operador", tone: "crit" },
  DevolvidoParaSetor: { icon: "⤷", label: "Transferido", tone: "warn" },
  RetornoCobrancaCliente: { icon: "⚠", label: "Cliente cobrou novamente", tone: "warn" },
  BastaoCardImportado: { icon: "↓", label: "Importado do Bastão", tone: "neutral" },
  BastaoCardAtualizado: { icon: "⟳", label: "Atualizado pelo Bastão", tone: "neutral" },
  ContextoFaltando: { icon: "?", label: "Contexto faltando", tone: "warn" },
  RespostaManualEnviada: { icon: "↗", label: "Resposta manual enviada", tone: "good" },
  AcaoExecutada: { icon: "✓", label: "Ação executada", tone: "good" },
  OcorrenciaSSWConfirmada: { icon: "✓", label: "Ocorrência SSW confirmada", tone: "good" },
  OcorrenciaSSWDetectada: { icon: "◐", label: "Ocorrência SSW detectada", tone: "info" },
};

function EventsTab({ card }: { card: CardRow }) {
  const { data, isLoading } = useQuery({
    queryKey: ["card-events", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("card_events")
        .select("id,card_id,event_type,event_version,payload,actor_type,actor_id,created_at")
        .eq("card_id", card.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CardEventRow[];
    },
  });
  useRealtimeInvalidate("card_events", ["card-events", card.id], `card_id=eq.${card.id}`);

  const [openId, setOpenId] = useState<string | null>(null);

  if (isLoading)
    return <div className="font-display text-[12px] italic text-ink-soft">Carregando…</div>;
  if (!data || data.length === 0)
    return (
      <div className="font-display text-[13px] italic text-ink-soft">
        Sem eventos registrados.
      </div>
    );

  return (
    <ol className="relative space-y-5 pl-8">
      <span aria-hidden className="absolute left-3 top-2 bottom-2 w-px bg-rule" />
      {data.map((e) => {
        const r = EVENT_RENDER[e.event_type] ?? {
          icon: "·",
          label: e.event_type,
          tone: "neutral" as const,
        };
        const toneStyles = {
          neutral: "bg-paper border-ink text-ink",
          good: "bg-good/15 border-good text-good",
          warn: "bg-warn/25 border-warn text-ink",
          crit: "bg-sal-tint border-sal text-sal-deep",
          info: "bg-info/10 border-info text-info",
        }[r.tone];
        const isOpen = openId === e.id;
        const payload = (e.payload ?? {}) as Record<string, any>;

        return (
          <li key={e.id} className="relative">
            <span
              className={cn(
                "absolute -left-8 top-0 flex h-6 w-6 items-center justify-center border-2 font-mono text-[11px] font-bold",
                toneStyles,
              )}
            >
              {r.icon}
            </span>
            <header className="mb-1 flex items-baseline justify-between gap-3">
              <h4 className="font-display text-[14px] font-semibold text-ink">{r.label}</h4>
              <span className="tabular font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                {format(new Date(e.created_at), "dd/MM HH:mm", { locale: ptBR })}
              </span>
            </header>
            <EventSubline event={e} payload={payload} type={e.event_type} />
            <button
              type="button"
              onClick={() => setOpenId(isOpen ? null : e.id)}
              className="mt-1 inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest text-ink-soft hover:text-sal"
            >
              <ChevronRight
                className={cn("h-3 w-3 transition-transform", isOpen && "rotate-90")}
              />
              {isOpen ? "Ocultar payload" : "Ver payload"}
            </button>
            {isOpen && (
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all border border-rule bg-paper-deep p-2 font-mono text-[10px] text-ink">
                {JSON.stringify(e.payload ?? {}, null, 2)}
              </pre>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function EventSubline({
  payload,
  type,
}: {
  event: CardEventRow;
  payload: Record<string, any>;
  type: string;
}) {
  const cls = "font-display text-[12px] italic text-ink-soft";
  switch (type) {
    case "AutoAprovacaoPermitida":
      return (
        <p className={cls}>
          Regra: <span className="font-mono not-italic">{String(payload.regra ?? "—")}</span>
        </p>
      );
    case "AcaoPropostaPeloAgente":
      return (
        <p className={cls}>
          {payload.cod_ultima_ocorrencia != null && (
            <>
              Última oc{" "}
              <span className="font-mono not-italic">{String(payload.cod_ultima_ocorrencia)}</span>
              {" · "}
            </>
          )}
          Cliente autorizou:{" "}
          {payload.cliente_autorizou_reentrega ? "sim" : "não"}
        </p>
      );
    case "DevolvidoParaSetor":
      return (
        <p className={cls}>
          Pra <span className="not-italic">{payload.setor_destino ?? "outro setor"}</span>
        </p>
      );
    case "RetornoCobrancaCliente":
      return (
        <p className={cls}>
          Cliente cobrou novamente
          {payload.canal && ` · ${payload.canal}`}
        </p>
      );
    case "RejeicaoOperador":
      return (
        <p className={cls}>
          Motivo: "{payload.motivo ?? "—"}"
        </p>
      );
    case "RespostaSugerida":
      return (
        <p className={cls}>
          Confiança: {payload.confianca ?? "—"}
          {payload.modelo_usado && ` · ${payload.modelo_usado}`}
        </p>
      );
    default:
      return null;
  }
}

/* ---------------- SSW ---------------- */

function formatHaMin(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

type AnaliseEvidencia = {
  transcricao_manuscrita: string;
  partes_relevantes: {
    carimbos: string[];
    assinaturas: string[];
    datas: string[];
  };
  resumo_situacao: string;
  oc_sugerida: number;
  template_email_sugerido: string | null;
  corpo_email_sugerido: string | null;
  motivo_sugestao: string;
  confianca: number;
};

function SswTab({ card }: { card: CardRow }) {
  const qc = useQueryClient();
  const [carregando, setCarregando] = useState(false);
  const [fotoOcAberta, setFotoOcAberta] = useState<number | null>(null);
  const [analisePorLinha, setAnalisePorLinha] = useState<Record<string, AnaliseEvidencia>>({});
  const [loadingPorLinha, setLoadingPorLinha] = useState<Record<string, boolean>>({});
  const [executandoPorLinha, setExecutandoPorLinha] = useState<Record<string, boolean>>({});
  const [reportarErroOc, setReportarErroOc] = useState<HistoricoSswOcorrencia | null>(null);

  const loginSswOperador = (card.responsavel_relacionamento ?? "").toLowerCase();

  async function handleExecutarSugestao(codigoOc: number, key: string, ocSugerida: number) {
    if (!supabase || codigoOc == null) return;
    setExecutandoPorLinha((prev) => ({ ...prev, [key]: true }));
    try {
      const { data, error } = await supabase.functions.invoke("executar-sugestao-evidencia", {
        body: { card_id: card.id, codigo_oc: codigoOc },
      });
      if (error || !data?.ok) {
        toast.error(`Erro: ${error?.message ?? data?.error ?? "desconhecido"}`);
        return;
      }
      if (data.reused) {
        toast.info(
          "Proposta IA já está aguardando aprovação. Role pra baixo nas opções e clique APROVAR no item 'sugestão IA, evidência'.",
        );
      } else {
        const detalhes: string[] = [];
        if (data.tem_email === true) detalhes.push("Email pré-preenchido pelo IA — você pode editar antes de enviar.");
        else if (data.tem_email === false && (data.oc === 54 || data.oc === 59)) detalhes.push("Lançamento sem email (cliente sem email cadastrado).");
        if (data.oc === 56) detalhes.push("Lançamento direto pra Operação (sem email cliente).");
        if (data.anexo_id) detalhes.push("Foto da evidência anexada automaticamente.");
        toast.success("Proposta IA criada! Role pra baixo e clique APROVAR pra enviar.", {
          description: detalhes.join(" ") || undefined,
        });
        if (data.anexo_erro) {
          toast.warning(`Foto SSW indisponível (${data.anexo_erro}) — proposta criada sem anexo.`);
        }
      }
      // Sinaliza pra ProposedActions destacar o todo IA recém-criado/existente
      window.dispatchEvent(
        new CustomEvent("highlight-ia-evidencia-todo", { detail: { cardId: card.id } }),
      );
      qc.invalidateQueries({ queryKey: ["card", card.id] });
      qc.invalidateQueries({ queryKey: ["cards"] });
      qc.invalidateQueries({ queryKey: ["todos"] });
    } catch (e) {
      toast.error(`Falha ao executar sugestão: ${(e as Error).message}`);
    } finally {
      setExecutandoPorLinha((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function handleInterpretar(codigoOc: number, key: string) {
    if (!supabase || codigoOc == null) return;
    setLoadingPorLinha((prev) => ({ ...prev, [key]: true }));
    try {
      const { SUPABASE_FUNCTIONS_URL, SUPABASE_ANON_KEY_PUBLIC } = await import("@/lib/supabase");
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token ?? SUPABASE_ANON_KEY_PUBLIC;
      const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/interpretador-evidencia-foto`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY_PUBLIC,
        },
        body: JSON.stringify({ card_id: card.id, codigo_oc: codigoOc }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.ok) {
        if (data?.error === "oc_sem_foto") {
          toast.info("Foto não disponível pra essa ocorrência.");
        } else if (typeof data?.error === "string" && data.error.startsWith("Anthropic")) {
          toast.error("IA indisponível, tente novamente em alguns minutos.");
        } else {
          toast.error(`Erro: ${data?.error ?? resp.statusText ?? "desconhecido"}`);
        }
        return;
      }
      setAnalisePorLinha((prev) => ({ ...prev, [key]: data.analise as AnaliseEvidencia }));
    } catch (e) {
      toast.error(`Falha na análise: ${(e as Error).message}`);
    } finally {
      setLoadingPorLinha((prev) => ({ ...prev, [key]: false }));
    }
  }

  const ocorrencias = (card.historico_ssw ?? []) as HistoricoSswOcorrencia[];
  const atualizadoEm = card.historico_ssw_atualizado_em ?? null;
  const temSnapshot = ocorrencias.length > 0;

  async function puxar() {
    if (!supabase) return;
    setCarregando(true);
    try {
      const { data, error } = await supabase.functions.invoke("puxar-historico-ssw-card", {
        body: { card_id: card.id },
      });
      if (error || !data?.ok) {
        toast.error("Falha ao puxar histórico SSW: " + (error?.message ?? data?.error ?? "erro desconhecido"));
        return;
      }
      toast.success(`✓ ${data.total ?? 0} ocorrências carregadas`);
      qc.invalidateQueries({ queryKey: ["card", card.id] });
    } catch (e) {
      toast.error("Falha ao puxar histórico SSW: " + (e as Error).message);
    } finally {
      setCarregando(false);
    }
  }

  function abrirFoto(codigoOc: number) {
    if (codigoOc == null) return;
    setFotoOcAberta(codigoOc);
  }


  const labelBotao = carregando
    ? "Buscando no SSW… (~3s)"
    : temSnapshot
    ? "Atualizar"
    : "Trazer Histórico SSW";

  if (!temSnapshot) {
    return (
      <div className="border border-dashed border-rule-strong bg-paper p-8 text-center">
        <p className="font-display text-[14px] italic text-ink-soft">
          Nenhum histórico carregado ainda.
        </p>
        <button
          onClick={puxar}
          disabled={carregando}
          className="mx-auto mt-4 border border-rule-strong bg-sal px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-paper transition-colors hover:bg-sal-deep disabled:opacity-50"
        >
          {labelBotao}
        </button>
        <p className="mt-4 font-display text-[12px] italic leading-snug text-ink-soft">
          O agente vai logar no SSW e trazer todas as ocorrências dessa NF. Latência típica ~3s.
        </p>
        <p className="mt-2 font-mono text-[10px] leading-snug text-ink-soft">
          ℹ Snapshot fica salvo por 24h pra economizar storage. Depois você precisa clicar de novo pra puxar versão atualizada.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 border-b border-rule pb-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
          Atualizado: {atualizadoEm ? format(new Date(atualizadoEm), "dd/MM HH:mm", { locale: ptBR }) : "—"}
          {atualizadoEm && <span className="ml-1.5 normal-case tracking-normal">({formatHaMin(atualizadoEm)})</span>}
        </span>
        <button
          onClick={puxar}
          disabled={carregando}
          className="border border-rule-strong bg-paper px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-ink transition-colors hover:bg-sal hover:text-paper disabled:opacity-50"
        >
          {labelBotao}
        </button>
      </div>

      <ul className="space-y-2">
        {ocorrencias.map((oc, idx) => {
          const semCabecalho = oc.codigo == null;
          const mostrarInstrucao =
            oc.instrucao && oc.instrucao.trim() !== "" && oc.instrucao.trim() !== oc.descricao?.trim();
          const fotoLoading = false;
          const linhaKey = `${oc.codigo ?? "x"}__${oc.data}__${idx}`;
          const analise = analisePorLinha[linhaKey];
          const loading = !!loadingPorLinha[linhaKey];
          return (
            <li
              key={idx}
              className="rounded-md border border-rule bg-surface p-3"
            >
              {!semCabecalho && (
                <div className="mb-1 flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                  <span className="tabular">
                    {oc.data}
                    {oc.filial && <span> · {oc.filial}</span>}
                    {oc.usuario && <span> · {oc.usuario}</span>}
                  </span>
                  <div className="flex items-center gap-1">
                    {oc.codigo != null &&
                      (!oc.usuario || !loginSswOperador || !oc.usuario.toLowerCase().startsWith(loginSswOperador.slice(0, 5))) && (
                        <button
                          type="button"
                          onClick={() => setReportarErroOc(oc)}
                          title="Reportar que essa ocorrência foi lançada errada pela base"
                          className="inline-flex items-center gap-1 border border-orange-400 bg-orange-50 px-1.5 py-0.5 text-[9px] font-bold tracking-widest text-orange-700 transition-colors hover:bg-orange-100"
                        >
                          Reportar erro
                        </button>
                      )}
                    {oc.tem_foto && oc.codigo != null && (
                      <>
                        <button
                          type="button"
                          onClick={() => abrirFoto(oc.codigo as number)}
                          disabled={fotoLoading}
                          className="inline-flex items-center gap-1 border border-blue-400 bg-blue-50 px-1.5 py-0.5 text-[9px] font-bold tracking-widest text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-60"
                        >
                          {fotoLoading ? "…" : "Ver Foto"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleInterpretar(oc.codigo as number, linhaKey)}
                          disabled={loading || !!analise}
                          title="A IA lê a foto e sugere oc + template email"
                          className="inline-flex items-center gap-1 border border-sal bg-sal/10 px-1.5 py-0.5 text-[9px] font-bold tracking-widest text-sal transition-colors hover:bg-sal/20 disabled:opacity-40"
                        >
                          {loading ? "Analisando…" : analise ? "✓ Analisado" : "Interpretar"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {!semCabecalho ? (
                <div className="font-display text-[13px] text-ink">
                  <span className="tabular font-mono font-bold">{oc.codigo}</span>
                  {oc.descricao && <span> — {oc.descricao}</span>}
                </div>
              ) : (
                <div className="font-display text-[13px] italic text-ink">{oc.instrucao}</div>
              )}
              {!semCabecalho && mostrarInstrucao && (
                <div className="mt-1 font-display text-[12px] italic text-ink-soft">
                  "{oc.instrucao}"
                </div>
              )}

              {analise && (
                <div className="mt-2 space-y-2 border-l-4 border-sal bg-sal/5 py-2 pl-3 text-sm">
                  <section>
                    <div className="mb-1 text-[9px] font-bold uppercase tracking-widest text-ink/60">
                      Transcrição
                    </div>
                    <div className="whitespace-pre-wrap text-xs leading-relaxed text-ink">
                      {analise.transcricao_manuscrita || "—"}
                    </div>
                  </section>

                  {(analise.partes_relevantes.carimbos.length > 0 ||
                    analise.partes_relevantes.assinaturas.length > 0 ||
                    analise.partes_relevantes.datas.length > 0) && (
                    <section className="grid grid-cols-3 gap-2 text-[11px]">
                      {analise.partes_relevantes.carimbos.length > 0 && (
                        <div>
                          <div className="mb-0.5 font-semibold text-ink/70">Carimbos</div>
                          <ul className="space-y-0.5 text-ink">
                            {analise.partes_relevantes.carimbos.map((c, i) => <li key={i}>• {c}</li>)}
                          </ul>
                        </div>
                      )}
                      {analise.partes_relevantes.assinaturas.length > 0 && (
                        <div>
                          <div className="mb-0.5 font-semibold text-ink/70">Assinaturas</div>
                          <ul className="space-y-0.5 text-ink">
                            {analise.partes_relevantes.assinaturas.map((a, i) => <li key={i}>• {a}</li>)}
                          </ul>
                        </div>
                      )}
                      {analise.partes_relevantes.datas.length > 0 && (
                        <div>
                          <div className="mb-0.5 font-semibold text-ink/70">Datas</div>
                          <ul className="space-y-0.5 text-ink">
                            {analise.partes_relevantes.datas.map((d, i) => <li key={i}>• {d}</li>)}
                          </ul>
                        </div>
                      )}
                    </section>
                  )}

                  <section>
                    <div className="mb-1 text-[9px] font-bold uppercase tracking-widest text-ink/60">
                      Resumo
                    </div>
                    <div className="text-xs text-ink">{analise.resumo_situacao}</div>
                  </section>

                  <section className="mt-1 border border-sal bg-paper p-2">
                    <div className="mb-1 flex items-center justify-between">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-sal">
                        Sugestão IA
                      </div>
                      <div className="text-[9px] font-semibold text-ink/60">
                        {Math.round(analise.confianca * 100)}% confiança
                      </div>
                    </div>
                    <div className="space-y-0.5 text-xs">
                      <div>
                        Lançar <span className="font-bold">oc {analise.oc_sugerida}</span>
                        {analise.template_email_sugerido && (
                          <> + email <span className="font-bold">{analise.template_email_sugerido}</span></>
                        )}
                      </div>
                      <div className="italic text-ink/70">{analise.motivo_sugestao}</div>
                    </div>

                    {analise.corpo_email_sugerido && (
                      <div className="mt-3 border-t border-sal/40 pt-2">
                        <div className="mb-1 flex items-center justify-between">
                          <div className="text-[10px] font-bold uppercase tracking-widest text-sal">
                            Corpo do e-mail (rascunho)
                          </div>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(analise.corpo_email_sugerido!);
                              toast.success("Corpo do email copiado");
                            }}
                            className="border border-sal bg-paper px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-sal transition-colors hover:bg-sal/10"
                          >
                            Copiar
                          </button>
                        </div>
                        <pre className="whitespace-pre-wrap border border-ink/10 bg-paper p-2 font-sans text-xs leading-relaxed text-ink">{analise.corpo_email_sugerido}</pre>
                        <div className="mt-1 text-[9px] italic text-ink/50">
                          Placeholders {"{nf}"} e {"{ctrc}"} serão substituídos pelo backend ao enviar. Revisar antes de aprovar.
                        </div>
                      </div>
                    )}

                    <div className="mt-2 text-[9px] italic text-ink/50">
                      Validação humana obrigatória — aprove pela aba AGUARDANDO VOCÊ.
                    </div>

                    {(analise.oc_sugerida === 54 || analise.oc_sugerida === 56) && (() => {
                      const executando = !!executandoPorLinha[linhaKey];
                      const label =
                        analise.oc_sugerida === 56
                          ? "EXECUTAR SUGESTÃO IA: lançar oc 56 (Operação)"
                          : analise.template_email_sugerido
                          ? "EXECUTAR SUGESTÃO IA: lançar oc 54 + email"
                          : "EXECUTAR SUGESTÃO IA: lançar oc 54";
                      return (
                        <button
                          type="button"
                          onClick={() => handleExecutarSugestao(oc.codigo as number, linhaKey, analise.oc_sugerida)}
                          disabled={executando}
                          className="mt-2 inline-flex w-full items-center justify-center gap-1 border-2 border-good bg-good px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-paper transition-colors hover:bg-good/90 disabled:opacity-60"
                        >
                          {executando ? "Criando proposta…" : label}
                        </button>
                      );
                    })()}
                  </section>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {fotoOcAberta != null && (
        <ModalEvidencia
          cardId={card.id}
          codigoOc={fotoOcAberta}
          open={fotoOcAberta != null}
          onClose={() => setFotoOcAberta(null)}
        />
      )}


      {reportarErroOc && (
        <ModalReportarErroLancamento
          cardId={card.id}
          ocorrencia={reportarErroOc}
          onClose={() => setReportarErroOc(null)}
        />
      )}
    </div>
  );
}

// Avoid unused warning
void Loader2;
