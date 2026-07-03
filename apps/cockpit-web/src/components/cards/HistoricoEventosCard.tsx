import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { cn } from "@/lib/utils";

type Categoria = "bastao" | "ssw" | "ia" | "operador" | "sistema";
type Severidade = "info" | "sucesso" | "atencao" | "erro";
type FiltroId = "todos" | "operador" | "sistema" | "ia" | "erros";

interface EventoLegivel {
  id: string;
  card_id: string;
  event_type: string;
  payload: Record<string, any> | null;
  actor_type: "operator" | "agent" | "system";
  actor_id: string | null;
  created_at: string;
  ator_nome: string;
  categoria: Categoria;
  severidade: Severidade;
  narrativa: string;
}

const LABEL_FILTRO: Record<FiltroId, string> = {
  todos: "Todos",
  operador: "Operador",
  sistema: "Sistema",
  ia: "IA",
  erros: "Atenção/Erros",
};

const FILTROS_ORDEM: FiltroId[] = ["todos", "operador", "sistema", "ia", "erros"];

function fmtHora(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Timestamp completo (data + hora + segundos + BRT) — preserva precisão de auditoria no tooltip. */
function fmtHoraFull(iso: string): string {
  return (
    new Date(iso).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }) + " BRT"
  );
}

export function HistoricoEventosCard({ cardId }: { cardId: string }) {
  const [filtro, setFiltro] = useState<FiltroId>("todos");
  const [openId, setOpenId] = useState<string | null>(null);

  const { data: eventos, isLoading } = useQuery({
    queryKey: ["historico-eventos", cardId],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_card_events_legivel")
        .select("*")
        .eq("card_id", cardId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as EventoLegivel[];
    },
  });

  useRealtimeInvalidate("card_events", ["historico-eventos", cardId], `card_id=eq.${cardId}`);

  const filtrados = (eventos ?? []).filter((e) => {
    if (filtro === "todos") return true;
    if (filtro === "operador") return e.categoria === "operador";
    if (filtro === "ia") return e.categoria === "ia";
    if (filtro === "sistema")
      return e.categoria === "sistema" || e.categoria === "bastao" || e.categoria === "ssw";
    if (filtro === "erros") return e.severidade === "erro" || e.severidade === "atencao";
    return true;
  });

  if (isLoading) {
    return <p className="text-[12px] italic text-ink-mute">Carregando…</p>;
  }

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTROS_ORDEM.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setFiltro(k)}
            className={cn(
              "rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
              filtro === k
                ? "border-ink bg-ink text-paper"
                : "border-rule bg-surface text-ink-mute hover:border-ink-mute hover:text-ink",
            )}
          >
            {LABEL_FILTRO[k]}
          </button>
        ))}
      </div>

      {/* Timeline — spine com nós por ator, narrativa primeiro, técnico recolhido */}
      {filtrados.length === 0 ? (
        <p className="text-[13px] italic text-ink-mute">Sem eventos nesse filtro.</p>
      ) : (
        <ol>
          {filtrados.map((ev, i) => {
            const isOpen = openId === ev.id;
            const last = i === filtrados.length - 1;
            const nodeColor =
              ev.categoria === "ia"
                ? "border-sal bg-sal"
                : ev.categoria === "operador"
                  ? "border-ink bg-ink"
                  : "border-rule-strong bg-surface";
            const narrColor =
              ev.severidade === "erro"
                ? "text-signal-strong"
                : ev.severidade === "atencao"
                  ? "text-warning"
                  : "text-ink";
            return (
              <li key={ev.id} className="grid grid-cols-[auto_1fr] gap-3">
                {/* Trilho + nó */}
                <div className="flex flex-col items-center">
                  <span className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-2", nodeColor)} />
                  {!last && <span className="w-px flex-1 bg-rule" />}
                </div>

                {/* Corpo */}
                <div className={cn("min-w-0", last ? "pb-0" : "pb-4")}>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span
                      className="tabular cursor-default font-mono text-[10px] text-ink-mute"
                      title={fmtHoraFull(ev.created_at)}
                    >
                      {fmtHora(ev.created_at)}
                    </span>
                    <span className="text-[11.5px] font-semibold text-ink">{ev.ator_nome}</span>
                  </div>
                  <p className={cn("mt-0.5 text-[13px] leading-snug", narrColor)}>{ev.narrativa}</p>
                  <button
                    type="button"
                    onClick={() => setOpenId(isOpen ? null : ev.id)}
                    className="mt-1 inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-ink-mute hover:text-ink"
                  >
                    <ChevronRight className={cn("h-3 w-3 transition-transform", isOpen && "rotate-90")} />
                    {ev.event_type}
                  </button>
                  {isOpen && (
                    <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-rule bg-surface-alt p-2.5 font-mono text-[10px] text-ink-soft">
                      {JSON.stringify(ev.payload ?? {}, null, 2)}
                    </pre>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
