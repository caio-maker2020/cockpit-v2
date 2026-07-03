import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { relativeShort } from "@/lib/format";
import { Bot, CheckCircle2, Info, AlertTriangle, Flag } from "lucide-react";
import { BotaoReportarErroAgente } from "@/components/extravios/BotaoReportarErroAgente";

type Metricas = {
  operador: string | null;
  lancadas: number | null;
  nao_rodou: number | null;
  reportadas_erradas: number | null;
  ultima_acao: string | null;
};

type Acao = {
  id?: string | number;
  card_id: string;
  nf: string | null;
  operador: string | null;
  event_type: string;
  descricao: string | null;
  oc_achada: number | null;
  created_at: string;
};

const TIPO_VISUAL: Record<
  string,
  { label: string; icon: typeof Bot; cls: string; dot: string }
> = {
  AgenteExtravioLancou49: {
    label: "Lançou oc 49",
    icon: CheckCircle2,
    cls: "border-emerald-300 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200",
    dot: "bg-emerald-500",
  },
  AgenteExtravioRecomendou: {
    label: "Recomendou lançar",
    icon: Info,
    cls: "border-sky-300 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 text-sky-800 dark:text-sky-200",
    dot: "bg-sky-500",
  },
  AgenteExtravioNaoRodou: {
    label: "Não rodou",
    icon: AlertTriangle,
    cls: "border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200",
    dot: "bg-amber-500",
  },
  AgenteExtravioReportadoErrado: {
    label: "Reportado errado",
    icon: Flag,
    cls: "border-rose-300 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200",
    dot: "bg-rose-500",
  },
};

export function AgenteExtravioSection() {
  const qc = useQueryClient();

  const { data: metricas = [] } = useQuery({
    queryKey: ["v_agente_extravio_metricas"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("v_agente_extravio_metricas")
        .select("*");
      if (error) throw error;
      return (data ?? []) as Metricas[];
    },
  });

  const { data: acoes = [], isLoading } = useQuery({
    queryKey: ["v_agente_extravio_auditoria"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("v_agente_extravio_auditoria")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Acao[];
    },
  });

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ["v_agente_extravio_auditoria"] });
    qc.invalidateQueries({ queryKey: ["v_agente_extravio_metricas"] });
  };

  return (
    <div className="space-y-4">
      {/* Track-record */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Bot className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          <h2 className="font-display text-[14px] font-semibold text-ink">
            Agente de extravio (oc 49 automática) — track-record
          </h2>
        </div>
        {metricas.length === 0 ? (
          <div className="border-2 border-ink/30 bg-paper px-3 py-2 font-display text-[12px] italic text-ink-soft">
            Sem métricas ainda.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {metricas.map((m, i) => (
              <div
                key={`${m.operador ?? "—"}-${i}`}
                className="border-2 border-ink bg-paper px-3 py-2"
              >
                <div className="font-display text-[13px] font-semibold text-ink">
                  {m.operador ?? "—"}
                </div>
                <div className="mt-1 font-mono text-[11px] text-ink-soft">
                  <span className="text-emerald-700 dark:text-emerald-400">
                    {m.lancadas ?? 0} lançadas
                  </span>
                  {" · "}
                  <span className="text-amber-700 dark:text-amber-400">
                    {m.nao_rodou ?? 0} não rodou
                  </span>
                  {" · "}
                  <span className="text-rose-700 dark:text-rose-400">
                    {m.reportadas_erradas ?? 0} reportadas erradas
                  </span>
                </div>
                {m.ultima_acao && (
                  <div className="mt-0.5 font-mono text-[10px] text-ink-soft">
                    última: {relativeShort(m.ultima_acao)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Timeline */}
      <section>
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
          Ações do agente ({acoes.length})
        </h3>
        {isLoading ? (
          <div className="font-display italic text-ink-soft">Carregando…</div>
        ) : acoes.length === 0 ? (
          <div className="border-2 border-ink/30 bg-paper px-3 py-2 font-display text-[12px] italic text-ink-soft">
            Nenhuma ação registrada.
          </div>
        ) : (
          <ul className="space-y-2">
            {acoes.map((a, i) => {
              const v =
                TIPO_VISUAL[a.event_type] ?? {
                  label: a.event_type,
                  icon: Info,
                  cls: "border-ink/30 bg-paper text-ink",
                  dot: "bg-ink/40",
                };
              const Icon = v.icon;
              return (
                <li
                  key={String(a.id ?? `${a.card_id}-${i}`)}
                  className={cn(
                    "border-2 px-3 py-2",
                    v.cls,
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "inline-flex h-2 w-2 rounded-full",
                            v.dot,
                          )}
                        />
                        <Icon className="h-3.5 w-3.5" />
                        <span className="font-mono text-[10px] font-bold uppercase tracking-widest">
                          {v.label}
                        </span>
                        <span className="font-mono text-[10px] opacity-70">
                          · {relativeShort(a.created_at)}
                        </span>
                      </div>
                      <div className="mt-1 font-display text-[13px]">
                        NF {a.nf ?? "—"}
                        {a.operador && (
                          <span className="ml-1 font-mono text-[11px] opacity-80">
                            · {a.operador}
                          </span>
                        )}
                        {a.oc_achada != null && (
                          <span className="ml-1 font-mono text-[11px] opacity-80">
                            · oc achada: {a.oc_achada}
                          </span>
                        )}
                      </div>
                      {a.descricao && (
                        <div className="mt-1 font-mono text-[11px] opacity-90">
                          {a.descricao}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Link
                        to={`/cards/${a.card_id}`}
                        className="border border-current/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest hover:opacity-80"
                      >
                        Ver card →
                      </Link>
                      {a.event_type !== "AgenteExtravioReportadoErrado" && (
                        <BotaoReportarErroAgente
                          cardId={a.card_id}
                          onReported={invalidar}
                          size="xs"
                        />
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
