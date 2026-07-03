import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, Loader2 } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { cn } from "@/lib/utils";

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

  return (
    <div className="flex h-full flex-col">
      <header className="border-b-2 border-ink bg-paper px-6 py-4">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-sal" />
          <div>
            <h1 className="font-display text-[20px] font-semibold leading-tight text-ink">
              ⚠️ Conflitos
              {total > 0 && (
                <span className="ml-2 inline-flex items-center border-2 border-ink bg-sal px-2 py-0.5 font-mono text-[11px] font-bold text-paper">
                  {total}
                </span>
              )}
            </h1>
            <p className="mt-0.5 font-display text-[13px] italic text-ink-soft">
              Cards cuja última ocorrência saiu do escopo de relacionamento — precisam da sua
              decisão de forçar a atualização.
            </p>
          </div>
          {isFetching && <Loader2 className="ml-auto h-4 w-4 animate-spin text-ink-soft" />}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-paper-deep/30 p-6">
        {isError ? (
          <div className="flex flex-col items-center gap-2 py-12 font-display italic text-ink-soft">
            <span>Erro ao carregar conflitos.</span>
            <button
              onClick={() => refetch()}
              className="border-2 border-ink bg-paper px-3 py-1 font-mono text-[10px] uppercase tracking-widest"
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
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <span className="font-display text-[40px] text-good">✅</span>
            <p className="font-display text-[15px] italic text-ink-soft">
              Nenhum conflito no momento.
            </p>
          </div>
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-3">
            {data!.map((r) => (
              <li key={r.card_id}>
                <Link
                  to={`/cards/${r.card_id}`}
                  className={cn(
                    "block border-2 border-ink bg-paper px-4 py-3 transition-colors",
                    "hover:border-sal hover:bg-sal/5",
                  )}
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-[11px] uppercase tracking-widest text-ink-soft">
                      NF
                    </span>
                    <span className="font-display text-[18px] font-semibold text-ink">
                      {r.nf || "—"}
                    </span>
                    <span className="font-display text-[14px] text-ink-soft">
                      {r.empresa_cliente || "Cliente sem identificação"}
                    </span>
                    <span
                      className="ml-auto inline-flex items-center border border-ink/30 bg-paper-deep px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-ink"
                      title={`Origem: ${r.de_state ?? r.state}`}
                    >
                      {STATE_LABEL[r.state] ?? r.state}
                    </span>
                  </div>

                  <p className="mt-1.5 text-[12.5px] text-ink">
                    A última ocorrência mudou:{" "}
                    <strong className="font-mono">oc {r.de_oc ?? "—"}</strong>{" "}
                    →{" "}
                    <strong className="font-mono">oc {r.para_oc ?? "—"}</strong>
                  </p>
                  <p className="mt-1 font-display text-[12px] italic text-ink-soft">
                    NF {r.nf || "—"} está com um conflito de ocorrência. Clique para verificar e aprovar.
                  </p>
                  <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                    <span>{r.ctrc ? `CTRC ${r.ctrc}` : ""}</span>
                    <span>Detectada em {formatDate(r.detectada_em)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
