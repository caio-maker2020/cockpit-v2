import { useMemo, useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ChevronDown, ChevronRight, Sparkles, Clock, AlertTriangle, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tratativa, TratativasEmailData } from "@/hooks/useTratativasEmail";
import EmailThread, { type EmailThreadMessage } from "./EmailThread";

interface MessageWithThread extends EmailThreadMessage {
  threadId: string | null;
}

interface Props {
  data: TratativasEmailData;
  messages: MessageWithThread[];
  onEscolher: (threadId: string) => void;
  escolhendo?: boolean;
}

function fmt(ts: string) {
  try {
    return format(new Date(ts), "dd/MM HH:mm", { locale: ptBR });
  } catch {
    return ts;
  }
}

function TratativaSection({
  t,
  isEscolhida,
  multiplas,
  onEscolher,
  escolhendo,
  defaultOpen,
  messages,
}: {
  t: Tratativa;
  isEscolhida: boolean;
  multiplas: boolean;
  onEscolher: () => void;
  escolhendo: boolean;
  defaultOpen: boolean;
  messages: EmailThreadMessage[];
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section
      className={cn(
        "border-2 bg-paper transition-colors",
        isEscolhida ? "border-sal" : "border-ink/20",
      )}
    >
      <header
        className={cn(
          "flex items-start justify-between gap-3 px-4 py-3",
          isEscolhida ? "bg-sal-tint" : "bg-paper-deep/30",
        )}
      >
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center gap-2 text-left"
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-soft" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-soft" />
            )}
            <h4 className="truncate font-display text-[14px] font-semibold text-ink">
              {t.assunto || "(sem assunto)"}
            </h4>
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-5">
            {t.analisada_pela_ia && (
              <span className="inline-flex items-center gap-1 border border-blue-600 bg-blue-50 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-blue-800">
                <Sparkles className="h-2.5 w-2.5" /> Analisada pela IA
              </span>
            )}
            {t.aguardando_resposta && (
              <span className="inline-flex items-center gap-1 border border-amber-600 bg-amber-50 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-amber-800">
                <Clock className="h-2.5 w-2.5" /> Aguardando resposta
              </span>
            )}
            {isEscolhida && (
              <span
                title="Tratativa principal — as respostas do Cockpit saem nesta thread"
                className="inline-flex items-center gap-1 border border-sal-deep bg-sal-deep px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-paper"
              >
                🏷️ Thread principal
              </span>
            )}
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">
              {t.qtd_mensagens} msg · {fmt(t.primeiro_em)} → {fmt(t.ultimo_em)}
            </span>
          </div>
          {t.participantes.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1 pl-5">
              {t.participantes.map((p) => (
                <span
                  key={p}
                  className="border border-ink/15 bg-paper px-1.5 py-0.5 font-mono text-[9px] text-ink-soft"
                >
                  {p}
                </span>
              ))}
            </div>
          )}
        </div>

        {multiplas && (
          <label
            className={cn(
              "flex shrink-0 cursor-pointer items-center gap-1.5 border-2 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider",
              isEscolhida
                ? "border-sal-deep bg-sal-deep text-paper"
                : "border-ink/30 bg-paper text-ink hover:border-ink",
            )}
          >
            <input
              type="radio"
              name="tratativa-escolhida"
              checked={isEscolhida}
              disabled={escolhendo}
              onChange={() => {
                if (!isEscolhida) onEscolher();
              }}
              className="h-3 w-3 accent-sal"
            />
            {isEscolhida ? "Responder esta" : "Responder esta tratativa"}
          </label>
        )}
      </header>

      {open && (
        <div className="px-4 py-3">
          {messages.length > 0 ? (
            <EmailThread messages={messages} />
          ) : (
            <div className="py-4 text-center font-display text-[12px] italic text-ink-soft">
              Sem mensagens carregadas para esta tratativa.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function TratativasEmailMultiplas({ data, messages, onEscolher, escolhendo }: Props) {
  const escolhida = data.tratativa_escolhida;

  // Agrupa mensagens (balões) por gmail_thread_id
  const { byThread, orphans } = useMemo(() => {
    const map = new Map<string, MessageWithThread[]>();
    const known = new Set(data.tratativas.map((t) => t.gmail_thread_id));
    const orph: MessageWithThread[] = [];
    for (const m of messages) {
      if (m.threadId && known.has(m.threadId)) {
        const arr = map.get(m.threadId) ?? [];
        arr.push(m);
        map.set(m.threadId, arr);
      } else {
        orph.push(m);
      }
    }
    return { byThread: map, orphans: orph };
  }, [messages, data.tratativas]);

  return (
    <div className="flex flex-col gap-3">
      {data.multiplas_tratativas && (
        <div
          className={cn(
            "flex items-start gap-2 border-2 px-3 py-2.5",
            escolhida
              ? "border-good bg-good/10"
              : "border-yellow-500 bg-yellow-100",
          )}
        >
          {escolhida ? (
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-good" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-700" />
          )}
          <div className="flex-1">
            <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink">
              {escolhida
                ? "Tratativa escolhida — você pode aprovar ações"
                : "Essa NF teve mais de uma tratativa no e-mail localizada"}
            </div>
            <div className="mt-0.5 font-display text-[12px] leading-snug text-ink-soft">
              {escolhida
                ? "A resposta será enviada na tratativa selecionada abaixo."
                : "Escolha qual tratativa você vai responder e finalizar antes de aprovar uma ação."}
            </div>
          </div>
        </div>
      )}

      {data.tratativas.map((t, idx) => (
        <TratativaSection
          key={t.gmail_thread_id}
          t={t}
          isEscolhida={t.gmail_thread_id === escolhida}
          multiplas={data.multiplas_tratativas}
          onEscolher={() => onEscolher(t.gmail_thread_id)}
          escolhendo={!!escolhendo}
          messages={byThread.get(t.gmail_thread_id) ?? []}
          defaultOpen={
            data.tratativas.length <= 2 ||
            t.gmail_thread_id === escolhida ||
            t.analisada_pela_ia ||
            idx === 0
          }
        />
      ))}

      {orphans.length > 0 && (
        <section className="border-2 border-dashed border-ink/20 bg-paper">
          <header className="border-b border-ink/10 bg-paper-deep/20 px-4 py-2">
            <h4 className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink-soft">
              Outras mensagens ({orphans.length})
            </h4>
            <div className="mt-0.5 font-display text-[11px] italic text-ink-soft">
              Mensagens sem vínculo claro com as tratativas acima.
            </div>
          </header>
          <div className="px-4 py-3">
            <EmailThread messages={orphans} />
          </div>
        </section>
      )}
    </div>
  );
}
