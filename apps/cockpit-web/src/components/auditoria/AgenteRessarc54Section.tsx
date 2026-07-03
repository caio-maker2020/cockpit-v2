import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { relativeShort } from "@/lib/format";
import { RotateCcw, CheckCircle2, Info, AlertTriangle, Flag } from "lucide-react";
import { BotaoReportarErroAgente } from "@/components/extravios/BotaoReportarErroAgente";

type Metricas = {
  operador: string | null;
  recomendadas: number | null;
  recomendadas_tier_a: number | null;
  recomendadas_tier_b: number | null;
  lancadas: number | null;
  lancadas_autonomo: number | null;
  lancadas_operador: number | null;
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
  tier: string | null;
  por_operador: boolean | null;
  descricao: string | null;
  payload?: Record<string, unknown> | null;
  created_at: string;
};

const TIPO_VISUAL: Record<
  string,
  { label: string; icon: typeof RotateCcw; cls: string; dot: string }
> = {
  RessarcRelancar54Recomendou: {
    label: "Recomendou relançar 54",
    icon: Info,
    cls: "border-sky-300 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 text-sky-800 dark:text-sky-200",
    dot: "bg-sky-500",
  },
  RessarcRelancar54Lancou: {
    label: "Lançou 54",
    icon: CheckCircle2,
    cls: "border-emerald-300 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200",
    dot: "bg-emerald-500",
  },
  RessarcRelancar54NaoRodou: {
    label: "Não rodou",
    icon: AlertTriangle,
    cls: "border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200",
    dot: "bg-amber-500",
  },
  RessarcRelancar54ReportadoErrado: {
    label: "Reportado errado",
    icon: Flag,
    cls: "border-rose-300 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200",
    dot: "bg-rose-500",
  },
};

export function AgenteRessarc54Section() {
  const qc = useQueryClient();

  const { data: metricas = [] } = useQuery({
    queryKey: ["v_ressarc54_metricas"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("v_ressarc54_metricas")
        .select("*");
      if (error) throw error;
      return (data ?? []) as Metricas[];
    },
  });

  const { data: acoes = [], isLoading } = useQuery({
    queryKey: ["v_ressarc54_auditoria"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("v_ressarc54_auditoria")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Acao[];
    },
  });

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ["v_ressarc54_auditoria"] });
    qc.invalidateQueries({ queryKey: ["v_ressarc54_metricas"] });
  };

  return (
    <div className="space-y-4">
      <section>
        <div className="mb-2 flex items-center gap-2">
          <RotateCcw className="h-4 w-4 text-sky-600 dark:text-sky-400" />
          <h2 className="font-display text-[14px] font-semibold text-ink">
            Agente relançar-54 (ressarcimento) — track-record
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
                  <span className="text-sky-700 dark:text-sky-400">
                    {m.recomendadas ?? 0} recomendadas
                  </span>
                  {" ("}
                  {m.recomendadas_tier_a ?? 0} A · {m.recomendadas_tier_b ?? 0} B
                  {") · "}
                  <span className="text-emerald-700 dark:text-emerald-400">
                    {m.lancadas ?? 0} lançadas
                  </span>
                  {" ("}
                  🤖 {m.lancadas_autonomo ?? 0} · 👤 {m.lancadas_operador ?? 0}
                  {") · "}
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
              const motivoNaoRodou =
                a.event_type === "RessarcRelancar54NaoRodou"
                  ? (a.payload?.motivo as string | undefined) ?? null
                  : null;
              return (
                <li
                  key={String(a.id ?? `${a.card_id}-${i}`)}
                  className={cn("border-2 px-3 py-2", v.cls)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn("inline-flex h-2 w-2 rounded-full", v.dot)} />
                        <Icon className="h-3.5 w-3.5" />
                        <span className="font-mono text-[10px] font-bold uppercase tracking-widest">
                          {v.label}
                        </span>
                        {a.tier && (
                          <span className="border border-current/40 px-1 font-mono text-[10px] font-bold uppercase tracking-widest">
                            tier {a.tier}
                          </span>
                        )}
                        {a.event_type === "RessarcRelancar54Lancou" && (
                          <span className="border border-current/40 px-1 font-mono text-[10px] font-bold uppercase tracking-widest">
                            {a.por_operador ? "👤 operador" : "🤖 autônomo"}
                          </span>
                        )}
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
                      </div>
                      {a.descricao && (
                        <div className="mt-1 font-mono text-[11px] opacity-90">
                          {a.descricao}
                        </div>
                      )}
                      {motivoNaoRodou && (
                        <div className="mt-1 font-mono text-[11px] opacity-90">
                          motivo: {motivoNaoRodou}
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
                      {a.event_type !== "RessarcRelancar54ReportadoErrado" && (
                        <BotaoReportarErroAgente
                          cardId={a.card_id}
                          rpcName="reportar_erro_ressarc54"
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
