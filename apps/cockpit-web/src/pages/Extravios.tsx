import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { PackageX, MapPin, RefreshCw, Bot, AlertTriangle } from "lucide-react";
import { BotaoReportarErroAgente } from "@/components/extravios/BotaoReportarErroAgente";
import {
  CockpitBoard,
  CockpitColumn,
  CockpitCard,
  CardIdentity,
  CockpitEmptyState,
  CockpitSummaryBar,
  CockpitStatTile,
  Chip,
  type Tone,
} from "@/components/cockpit";

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

// Faixas por dias úteis + lane do agente. Tone = mesmo vocabulário de cor do
// kit (ponto de estado da coluna), como no Inbox.
const COLUNAS: { id: ColunaKanban; titulo: string; tone: Tone }[] = [
  { id: "D1", titulo: "D1 · 1 dia útil", tone: "slate" },
  { id: "D2", titulo: "D2 · 2 dias úteis", tone: "sky" },
  { id: "D3", titulo: "D3 · 3 dias úteis", tone: "amber" },
  { id: "D4", titulo: "D4 · 4+ dias úteis", tone: "orange" },
  { id: "NAO_RODOU", titulo: "Autônomo não rodou", tone: "violet" },
];

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
  // KPIs read-only derivados do array já buscado (nenhuma query nova).
  const statSlaRisco = useMemo(
    () => cards.filter((c) => c.coluna_kanban !== "NAO_RODOU" && (c.dias_uteis ?? 0) >= 4).length,
    [cards],
  );
  const statRecomendado = useMemo(
    () => cards.filter((c) => c.agente_extravio_status === "recomendado").length,
    [cards],
  );

  return (
    <div className="flex h-full flex-col bg-paper">
      <header className="flex items-start justify-between border-b border-rule px-7 pb-4 pt-5">
        <div className="min-w-0">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
            Extravios
          </div>
          <h1 className="mt-1 text-[30px] font-semibold leading-[1.15] text-ink-2" style={{ letterSpacing: "-0.01em" }}>
            <span style={{ color: "var(--signal)" }}>{cards.length} {cards.length === 1 ? "NF" : "NFs"}</span>{" "}
            em extravio, por dias úteis sem localização.
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-soft-2">
            Ocs 6/9/16 (sob Perdas) dos seus clientes.
          </p>
        </div>
        <BotaoAtualizarTodas
          onDone={() => queryClient.invalidateQueries({ queryKey: ["v_extravios_kanban"] })}
        />
      </header>

      {/* Barra de KPIs (read-only) — mesmo componente do Inbox */}
      <CockpitSummaryBar>
        <CockpitStatTile label="Em extravio" value={cards.length} accent="ink" />
        <CockpitStatTile
          label="SLA ≥ 4 dias"
          value={statSlaRisco}
          accent="sal"
          hint={statSlaRisco > 0 ? "crítico" : undefined}
        />
        <CockpitStatTile label="Aguardando verificação" value={totalNaoRodou} accent="violet" />
        <CockpitStatTile label="Agente recomenda" value={statRecomendado} accent="green" />
      </CockpitSummaryBar>

      <div className="min-h-0 flex-1 overflow-hidden">
        <CockpitBoard>
          {COLUNAS.map((col) => {
            const cardsCol = cards.filter((c) => c.coluna_kanban === col.id);
            return (
              <CockpitColumn key={col.id} tone={col.tone} title={col.titulo} count={cardsCol.length}>
                {isLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-[120px] animate-pulse rounded-md border border-rule bg-surface-alt/60"
                    />
                  ))
                ) : cardsCol.length === 0 ? (
                  <CockpitEmptyState glyph="○" text="Nenhuma NF nesta faixa." />
                ) : (
                  cardsCol.map((card) => (
                    <CardExtravioItem
                      key={card.card_id}
                      card={card}
                      onClick={() => navigate(`/cards/${card.card_id}`)}
                      onReported={() =>
                        queryClient.invalidateQueries({ queryKey: ["v_extravios_kanban"] })
                      }
                    />
                  ))
                )}
              </CockpitColumn>
            );
          })}
        </CockpitBoard>
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
  const spine: Tone = naoRodou ? "violet" : urgente ? "sal" : "none";

  return (
    <CockpitCard spine={spine} onClick={onClick}>
      {/* Zona 1 — identidade: NF · CTRC · oc */}
      <CardIdentity
        nf={card.nf}
        ctrc={card.ctrc ?? undefined}
        right={<span className="font-mono text-[10px] text-ink-mute">oc {card.oc_extravio}</span>}
      />

      {/* Título = quem (pagador/cliente) */}
      <h3 className="mt-1.5 truncate text-[13.5px] font-semibold leading-snug text-ink">
        {card.pagador_nome ?? card.empresa_cliente ?? "—"}
      </h3>

      {/* Meta operacional = base · dias úteis (Sal quando no SLA) */}
      <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] leading-snug text-ink-soft">
        <MapPin className="h-3 w-3 shrink-0" />
        <span className="truncate">{card.base_destino ?? "—"}</span>
        <span className="text-ink-mute">·</span>
        <span
          className={cn("tabular font-mono", urgente ? "font-semibold text-sal" : "text-ink-soft")}
        >
          {card.dias_uteis ?? 1} {(card.dias_uteis ?? 1) === 1 ? "dia útil" : "dias úteis"}
        </span>
      </div>

      {card.instrucao && !naoRodou && (
        <p className="mt-1 truncate text-[10px] italic text-ink-mute">"{card.instrucao}"</p>
      )}

      {recomendado && !naoRodou && (
        <div className="mt-1.5">
          <Chip tone="positive">
            <Bot className="mr-1 h-3 w-3" />
            agente recomenda lançar oc 49
          </Chip>
        </div>
      )}

      {naoRodou && (
        <div className="mt-1.5 space-y-1 rounded-md border border-rule bg-warning-soft p-2">
          <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-warning">
            <AlertTriangle className="h-3 w-3" />
            Não lançou — verificar
          </div>
          {card.agente_extravio_motivo && (
            <div className="whitespace-pre-wrap text-[11px] text-ink">
              {card.agente_extravio_motivo}
            </div>
          )}
          {card.agente_extravio_oc_achada != null && (
            <div className="font-mono text-[10px] text-ink-soft">
              oc achada no SSW: {card.agente_extravio_oc_achada}
            </div>
          )}
        </div>
      )}

      {naoRodou && (
        <div className="mt-1.5">
          <BotaoReportarErroAgente cardId={card.card_id} onReported={onReported} size="xs" />
        </div>
      )}
    </CockpitCard>
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
        "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
        bloqueado
          ? "cursor-not-allowed border-rule text-ink-mute"
          : "border-rule-strong text-ink hover:bg-paper-deep",
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
