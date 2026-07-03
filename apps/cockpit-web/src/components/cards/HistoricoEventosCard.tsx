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

const ICONE_POR_CATEGORIA: Record<Categoria, string> = {
  bastao: "🔗",
  ssw: "🚛",
  ia: "✦",
  operador: "👤",
  sistema: "⚙",
};

const LABEL_FILTRO: Record<FiltroId, string> = {
  todos: "Todos",
  operador: "Operador",
  sistema: "Sistema",
  ia: "IA",
  erros: "Atenção/Erros",
};

const FILTROS_ORDEM: FiltroId[] = ["todos", "operador", "sistema", "ia", "erros"];

const SEVERIDADE_CLASSE: Record<Severidade, string> = {
  info: "bg-indigo-50 border-indigo-200 text-indigo-900 dark:bg-indigo-950 dark:border-indigo-800 dark:text-indigo-100",
  sucesso: "bg-emerald-50 border-emerald-200 text-emerald-900 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-100",
  atencao: "bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950 dark:border-amber-800 dark:text-amber-100",
  erro: "bg-rose-50 border-rose-200 text-rose-900 dark:bg-rose-950 dark:border-rose-800 dark:text-rose-100",
};

function fmtHora(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
    if (filtro === "sistema") return e.categoria === "sistema" || e.categoria === "bastao" || e.categoria === "ssw";
    if (filtro === "erros") return e.severidade === "erro" || e.severidade === "atencao";
    return true;
  });

  if (isLoading) {
    return <p className="font-display text-[12px] italic text-ink-soft">Carregando…</p>;
  }

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTROS_ORDEM.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setFiltro(k)}
            className={cn(
              "rounded border px-3 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
              filtro === k
                ? "border-ink bg-ink text-bg"
                : "border-ink-mute/30 bg-bg text-ink-mute hover:border-ink hover:text-ink",
            )}
          >
            {LABEL_FILTRO[k]}
          </button>
        ))}
      </div>

      {/* Lista */}
      {filtrados.length === 0 ? (
        <p className="font-display text-[13px] italic text-ink-soft">Sem eventos nesse filtro.</p>
      ) : (
        <ol className="space-y-3">
          {filtrados.map((ev) => {
            const isOpen = openId === ev.id;
            const sev = SEVERIDADE_CLASSE[ev.severidade] ?? SEVERIDADE_CLASSE.info;
            return (
              <li
                key={ev.id}
                className={cn("rounded border px-3 py-2.5", sev)}
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-current/20 bg-bg/60 text-[14px]"
                  >
                    {ICONE_POR_CATEGORIA[ev.categoria] ?? "·"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <header className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <span className="tabular font-mono text-[10px] uppercase tracking-widest opacity-70">
                        {fmtHora(ev.created_at)}
                      </span>
                      <span className="font-display text-[12px] font-semibold">
                        {ev.ator_nome}
                      </span>
                    </header>
                    <p className="mt-1 font-display text-[13px] leading-snug">{ev.narrativa}</p>
                    <button
                      type="button"
                      onClick={() => setOpenId(isOpen ? null : ev.id)}
                      className="mt-1.5 inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest opacity-60 hover:opacity-100"
                    >
                      <ChevronRight className={cn("h-3 w-3 transition-transform", isOpen && "rotate-90")} />
                      detalhe técnico ({ev.event_type})
                    </button>
                    {isOpen && (
                      <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-current/20 bg-bg/70 p-2 font-mono text-[10px]">
                        {JSON.stringify(ev.payload ?? {}, null, 2)}
                      </pre>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
