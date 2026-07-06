import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import {
  CockpitCard,
  CardIdentity,
  CardMetaFooter,
  CockpitEmptyState,
  CockpitSummaryBar,
  CockpitStatTile,
} from "@/components/cockpit";

interface ConflitoRow {
  card_id: string;
  nf: string | null;
  ctrc: string | null;
  state: string;
  empresa_cliente: string | null;
  assigned_operator_id: string | null;
  de_oc: number | null;
  para_oc: number | null;
  oc_fora_escopo: number | null;
  de_state: string | null;
  origem_pass: string | null;
  detectada_em: string | null;
}

const STATE_LABEL: Record<string, string> = {
  AGUARDANDO_VALIDACAO_HUMANA: "Aguardando Você",
  AGUARDANDO_CLIENTE: "Aguardando Cliente",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function Conflitos() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["conflitos"],
    enabled: !!supabase,
    // Sem polling: realtime via useRealtimeInvalidate("cards") abaixo cobre updates.
    // Aba conflitos normalmente vazia — não precisa de refetchInterval.
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("v_cards_requer_atencao")
        .select("*")
        .order("detectada_em", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ConflitoRow[];
    },
  });

  useRealtimeInvalidate("cards", ["conflitos"]);

  const total = data?.length ?? 0;
  // KPIs read-only derivados dos dados já buscados (nenhuma query nova).
  const statAvh = (data ?? []).filter((r) => r.state === "AGUARDANDO_VALIDACAO_HUMANA").length;
  const statCliente = (data ?? []).filter((r) => r.state === "AGUARDANDO_CLIENTE").length;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-rule bg-paper px-6 py-4">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-sal" />
          <div>
            <h1 className="font-display text-[20px] font-semibold leading-tight text-ink">
              Conflitos
            </h1>
            <p className="mt-0.5 font-display text-[13px] italic text-ink-soft">
              Cards cuja última ocorrência saiu do escopo de relacionamento — precisam da sua
              decisão de forçar a atualização.
            </p>
          </div>
          {isFetching && <Loader2 className="ml-auto h-4 w-4 animate-spin text-ink-soft" />}
        </div>
      </header>

      {/* Barra de KPIs (read-only) — mesmo componente do Inbox */}
      <CockpitSummaryBar>
        <CockpitStatTile
          label="Conflitos abertos"
          value={total}
          accent={total > 0 ? "sal" : "ink"}
          hint={total > 0 ? "requer decisão" : undefined}
        />
        <CockpitStatTile label="Aguardando você" value={statAvh} accent="amber" />
        <CockpitStatTile label="Aguardando cliente" value={statCliente} accent="ink" />
      </CockpitSummaryBar>

      <div className="min-h-0 flex-1 overflow-y-auto bg-paper p-6">
        {isError ? (
          <div className="flex flex-col items-center gap-2 py-12 font-display italic text-ink-soft">
            <span>Erro ao carregar conflitos.</span>
            <button
              onClick={() => refetch()}
              className="border border-rule-strong bg-surface px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-soft transition-colors hover:border-ink hover:text-ink"
            >
              Tentar novamente
            </button>
          </div>
        ) : isLoading ? (
          <div className="flex items-center gap-2 py-12 font-display italic text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" />
            Carregando…
          </div>
        ) : total === 0 ? (
          <CockpitEmptyState glyph="✓" text="Nenhum conflito no momento." />
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-2">
            {data!.map((r) => (
              <li key={r.card_id}>
                <CockpitCard spine="sal" to={`/cards/${r.card_id}`}>
                  {/* Zona 1 — identidade: NF · estado */}
                  <CardIdentity
                    nf={r.nf || "—"}
                    right={
                      <span
                        className="rounded-full border border-rule bg-surface-alt px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-soft"
                        title={`Origem: ${r.de_state ?? r.state}`}
                      >
                        {STATE_LABEL[r.state] ?? r.state}
                      </span>
                    }
                  />

                  {/* Título = quem (cliente) */}
                  <h3 className="mt-1.5 truncate text-[13.5px] font-semibold leading-snug text-ink">
                    {r.empresa_cliente || "Cliente sem identificação"}
                  </h3>

                  {/* Meta operacional = a mudança de ocorrência */}
                  <p className="mt-0.5 text-[11.5px] leading-snug text-ink-soft">
                    Última ocorrência mudou:{" "}
                    <span className="font-mono text-ink">oc {r.de_oc ?? "—"}</span> →{" "}
                    <span className="font-mono text-ink">oc {r.para_oc ?? "—"}</span>
                    <span className="text-ink-mute"> · não-relacionamento</span>
                  </p>

                  <CardMetaFooter
                    left={<span className="tabular">{r.ctrc ? `CTRC ${r.ctrc}` : "—"}</span>}
                    right={<span className="tabular">Detectada {formatDate(r.detectada_em)}</span>}
                  />
                </CockpitCard>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
