import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { PackageX, MapPin, RefreshCw, Bot, AlertTriangle } from "lucide-react";
import { BotaoReportarErroAgente } from "@/components/extravios/BotaoReportarErroAgente";

type ColunaKanban = "D1" | "D2" | "D3" | "D4" | "NAO_RODOU";
type AgenteStatus = null | "recomendado" | "nao_rodou" | "lancou";

type CardExtravio = {
  card_id: string;
  nf: string;
  ctrc: string | null;
  base_destino: string | null;
  empresa_cliente: string | null;
  pagador_nome: string | null;
  oc_extravio: number;
  instrucao: string | null;
  qtde_volumes: number | null;
  data_lancamento: string | null;
  dias_uteis: number | null;
  coluna_kanban: ColunaKanban;
  agente_extravio_status: AgenteStatus;
  agente_extravio_motivo: string | null;
  agente_extravio_oc_achada: number | null;
  agente_extravio_checado_em: string | null;
};

const COLUNAS = [
  { id: "D1", titulo: "D1 · 1 dia útil", accent: "bg-zinc-100 dark:bg-zinc-800", dot: "bg-zinc-400" },
  { id: "D2", titulo: "D2 · 2 dias úteis", accent: "bg-sky-50 dark:bg-sky-950/30", dot: "bg-sky-400" },
  { id: "D3", titulo: "D3 · 3 dias úteis", accent: "bg-amber-50 dark:bg-amber-950/30", dot: "bg-amber-400" },
  { id: "D4", titulo: "D4 · 4+ dias úteis", accent: "bg-orange-50 dark:bg-orange-950/30", dot: "bg-orange-500" },
  { id: "NAO_RODOU", titulo: "🤖 Autônomo não rodou", accent: "bg-purple-50 dark:bg-purple-950/30", dot: "bg-purple-500" },
] as const;

function useExtravios() {
  return useQuery({
    queryKey: ["v_extravios_kanban"],
    queryFn: async () => {
      if (!supabase) return [] as CardExtravio[];
      const { data, error } = await supabase
        .from("v_extravios_kanban")
        .select("*")
        .order("dias_uteis", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CardExtravio[];
    },
    // Sem polling: realtime de `cards` (effect abaixo) invalida quando há mudança.
    staleTime: 60_000,
  });
}

export default function Extravios() {
  const { data: cards = [], isLoading } = useExtravios();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (!supabase) return;
    const ch = supabase
      .channel("extravios-kanban")
      .on("postgres_changes", { event: "*", schema: "public", table: "cards" }, () =>
        queryClient.invalidateQueries({ queryKey: ["v_extravios_kanban"] }),
      )
      .subscribe();
    return () => {
      supabase?.removeChannel(ch);
    };
  }, [queryClient]);

  const totalNaoRodou = useMemo(
    () => cards.filter((c) => c.coluna_kanban === "NAO_RODOU").length,
    [cards],
  );

  return (
    <div className="flex h-full flex-col bg-zinc-50 dark:bg-zinc-950 font-[Inter]">
      <header className="flex items-start justify-between border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4">
        <div className="flex items-start gap-3">
          <PackageX className="h-5 w-5 mt-0.5 text-zinc-700 dark:text-zinc-300" />
          <div>
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Extravios</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              NFs dos seus clientes em extravio (oc 6/9/16, sob Perdas) — por dias úteis sem localização
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-mono text-zinc-600 dark:text-zinc-400">
            {cards.length} em extravio
            {totalNaoRodou > 0 && (
              <span className="ml-1 text-purple-600 dark:text-purple-400">
                · {totalNaoRodou} aguardando verificação
              </span>
            )}
          </div>
          <BotaoAtualizarTodas
            onDone={() => queryClient.invalidateQueries({ queryKey: ["v_extravios_kanban"] })}
          />
        </div>
      </header>

      <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
        <div className="flex gap-3 h-full min-w-max">
          {COLUNAS.map((col) => {
            const cardsCol = cards.filter((c) => c.coluna_kanban === col.id);
            return (
              <div
                key={col.id}
                className="flex flex-col w-[260px] shrink-0 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"
              >
                <div className={cn("flex items-center justify-between px-3 py-2 rounded-t-md", col.accent)}>
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2 w-2 rounded-full", col.dot)} />
                    <span className="text-xs font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-200">
                      {col.titulo}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-zinc-600 dark:text-zinc-400">
                    {cardsCol.length}
                  </span>
                </div>

                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {isLoading &&
                    Array.from({ length: 3 }).map((_, i) => (
                      <div
                        key={i}
                        className="h-[120px] rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 animate-pulse"
                      />
                    ))}
                  {!isLoading && cardsCol.length === 0 && (
                    <p className="text-center text-[11px] text-zinc-400 py-6">Vazio</p>
                  )}
                  {cardsCol.map((card) => (
                    <CardExtravioItem
                      key={card.card_id}
                      card={card}
                      onClick={() => navigate(`/cards/${card.card_id}`)}
                      onReported={() =>
                        queryClient.invalidateQueries({ queryKey: ["v_extravios_kanban"] })
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CardExtravioItem({
  card,
  onClick,
  onReported,
}: {
  card: CardExtravio;
  onClick: () => void;
  onReported?: () => void;
}) {
  const naoRodou = card.coluna_kanban === "NAO_RODOU";
  const urgente = !naoRodou && (card.dias_uteis ?? 0) >= 4;
  const recomendado = card.agente_extravio_status === "recomendado";
  return (
    <div
      className={cn(
        "rounded border bg-white dark:bg-zinc-900",
        naoRodou
          ? "border-purple-300 dark:border-purple-900"
          : urgente
            ? "border-orange-300 dark:border-orange-900"
            : "border-zinc-200 dark:border-zinc-800",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left p-2.5 space-y-1.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
      >
        <div className="flex items-center justify-between">
          <span className="font-mono text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
            NF {card.nf}
          </span>
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
            oc={card.oc_extravio}
          </span>
        </div>

        {card.ctrc && (
          <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            CTRC {card.ctrc}
          </div>
        )}

        <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
          <MapPin className="h-3 w-3" />
          <span className="truncate">{card.base_destino ?? "—"}</span>
          <span>·</span>
          <span
            className={cn(
              "font-mono font-semibold",
              urgente ? "text-orange-600 dark:text-orange-400" : "text-zinc-700 dark:text-zinc-300",
            )}
          >
            {card.dias_uteis ?? 1} {(card.dias_uteis ?? 1) === 1 ? "dia útil" : "dias úteis"}
          </span>
        </div>

        <div className="text-[11px] text-zinc-700 dark:text-zinc-300 truncate">
          {card.pagador_nome ?? card.empresa_cliente ?? "—"}
        </div>

        {card.instrucao && !naoRodou && (
          <div className="text-[10px] italic text-zinc-500 dark:text-zinc-400 truncate">
            "{card.instrucao}"
          </div>
        )}

        {recomendado && !naoRodou && (
          <div className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900">
            <Bot className="h-3 w-3" />
            agente recomenda lançar oc 49
          </div>
        )}

        {naoRodou && (
          <div className="mt-1 rounded border border-purple-200 dark:border-purple-900 bg-purple-50 dark:bg-purple-950/40 p-2 space-y-1">
            <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-purple-700 dark:text-purple-300">
              <AlertTriangle className="h-3 w-3" />
              Não lançou — verificar
            </div>
            {card.agente_extravio_motivo && (
              <div className="text-[11px] text-purple-900 dark:text-purple-100 whitespace-pre-wrap">
                {card.agente_extravio_motivo}
              </div>
            )}
            {card.agente_extravio_oc_achada != null && (
              <div className="font-mono text-[10px] text-purple-700 dark:text-purple-300">
                oc achada no SSW: {card.agente_extravio_oc_achada}
              </div>
            )}
          </div>
        )}
      </button>
      {naoRodou && (
        <div className="px-2.5 pb-2.5">
          <BotaoReportarErroAgente cardId={card.card_id} onReported={onReported} size="xs" />
        </div>
      )}
    </div>
  );
}

function BotaoAtualizarTodas({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<{
    bloqueado: boolean;
    segundos_restantes: number;
    motivo: string | null;
  } | null>(null);
  const [rodando, setRodando] = useState(false);

  const carregarStatus = async () => {
    if (!supabase) return;
    const { data } = await supabase.rpc("extravios_atualizar_status");
    setStatus(data as any);
  };

  useEffect(() => {
    carregarStatus();
    // Polling pra mostrar cooldown — só roda com aba visível, mínimo 60s.
    const tick = () => {
      if (document.visibilityState === "visible") carregarStatus();
    };
    const id = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  useEffect(() => {
    if (!status?.bloqueado) return;
    const t = setInterval(
      () =>
        setStatus((s) =>
          s && s.segundos_restantes > 0
            ? {
                ...s,
                segundos_restantes: s.segundos_restantes - 1,
                bloqueado: s.segundos_restantes - 1 > 0,
              }
            : s,
        ),
      1000,
    );
    return () => clearInterval(t);
  }, [status?.bloqueado]);

  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const tip =
    status?.motivo === "sync_bastao"
      ? "Atualizado pelo Bastão há pouco"
      : status?.motivo === "clique_operador"
        ? "Você atualizou há pouco"
        : "";

  const clicar = async () => {
    if (!supabase) return;
    setRodando(true);
    try {
      const { data } = await supabase.functions.invoke("atualizar-extravios-todas");
      const d = data as any;
      if (d?.bloqueado) {
        await carregarStatus();
        return;
      }
      onDone();
    } finally {
      setRodando(false);
      await carregarStatus();
    }
  };

  const bloqueado = !!status?.bloqueado || rodando;
  return (
    <button
      onClick={clicar}
      disabled={bloqueado}
      title={tip}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border transition-colors",
        bloqueado
          ? "border-zinc-200 text-zinc-400 cursor-not-allowed dark:border-zinc-700"
          : "border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800",
      )}
    >
      <RefreshCw className={cn("w-3.5 h-3.5", rodando && "animate-spin")} />
      {rodando
        ? "Atualizando…"
        : status?.bloqueado
          ? `Liberado em ${fmt(status.segundos_restantes)}`
          : "Atualizar todas"}
    </button>
  );
}
