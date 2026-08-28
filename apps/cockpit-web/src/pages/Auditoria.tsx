import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { relativeShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PainelAutonomasSection } from "@/components/auditoria/PainelAutonomasSection";
import { AgenteExtravioSection } from "@/components/auditoria/AgenteExtravioSection";
import { JanelaVetoSection } from "@/components/auditoria/JanelaVetoSection";
import { BotaoReportarErroAgente } from "@/components/extravios/BotaoReportarErroAgente";

type Aba = "executadas" | "todos" | "agente_extravio" | "janela_veto";
type Periodo = "24h" | "7d" | "30d" | "all";

type LinhaRessarc = {
  id?: string | number;
  card_id: string;
  nf: string | null;
  operador: string | null;
  event_type: string;
  tier: string | null;
  descricao: string | null;
  created_at: string;
};

type LinhaExtravio = {
  id?: string | number;
  card_id: string;
  nf: string | null;
  operador: string | null;
  event_type: string;
  descricao: string | null;
  oc_achada: number | null;
  created_at: string;
};

type AcaoUnificada = {
  key: string;
  card_id: string;
  nf: string | null;
  operador: string | null;
  agente: "ressarcimento_54" | "extravio";
  event_type: string;
  acao_label: string;
  tier: string | null;
  descricao: string | null;
  created_at: string;
};

function periodoToISO(p: Periodo): string | null {
  if (p === "all") return null;
  const ms = p === "24h" ? 24 : p === "7d" ? 24 * 7 : 24 * 30;
  return new Date(Date.now() - ms * 60 * 60 * 1000).toISOString();
}

const EVENT_TYPES_AUTONOMOS = ["RessarcRelancar54Lancou", "AgenteExtravioLancou49"];

export default function Auditoria() {
  const [aba, setAba] = useState<Aba>("todos");
  const [periodo, setPeriodo] = useState<Periodo>("all");
  const qc = useQueryClient();

  const since = periodoToISO(periodo);

  const ressarcQuery = useQuery({
    queryKey: ["v_ressarc54_auditoria", "auditoria-autonomas", periodo],
    enabled: !!supabase && aba === "todos",
    queryFn: async () => {
      let q = supabase!
        .from("v_ressarc54_auditoria")
        .select("id, card_id, nf, operador, event_type, tier, descricao, created_at")
        .order("created_at", { ascending: false })
        .limit(500);
      if (since) q = q.gte("created_at", since);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as LinhaRessarc[];
    },
  });

  const extravioQuery = useQuery({
    queryKey: ["v_agente_extravio_auditoria", "auditoria-autonomas", periodo],
    enabled: !!supabase && aba === "todos",
    queryFn: async () => {
      let q = supabase!
        .from("v_agente_extravio_auditoria")
        .select("id, card_id, nf, operador, event_type, descricao, oc_achada, created_at")
        .order("created_at", { ascending: false })
        .limit(500);
      if (since) q = q.gte("created_at", since);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as LinhaExtravio[];
    },
  });

  // Realtime: qualquer INSERT em card_events com event_type autônomo → invalida tudo de auditoria.
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel("auditoria-autonomas")
      .on(
        "postgres_changes" as never,
        { event: "INSERT", schema: "public", table: "card_events" },
        (payload: { new?: { event_type?: string } }) => {
          const t = payload?.new?.event_type;
          if (!t || !EVENT_TYPES_AUTONOMOS.includes(t)) return;
          qc.invalidateQueries({ queryKey: ["v_ressarc54_auditoria"] });
          qc.invalidateQueries({ queryKey: ["v_agente_extravio_auditoria"] });
          qc.invalidateQueries({ queryKey: ["v_ressarc54_metricas"] });
          qc.invalidateQueries({ queryKey: ["v_agente_extravio_metricas"] });
          qc.invalidateQueries({ queryKey: ["auditoria", "count-24h"] });
        },
      )
      .subscribe();
    return () => {
      supabase!.removeChannel(channel);
    };
  }, [qc]);

  // Fallback: refetch ao voltar foco da aba.
  useEffect(() => {
    const onFocus = () => {
      qc.invalidateQueries({ queryKey: ["v_ressarc54_auditoria"] });
      qc.invalidateQueries({ queryKey: ["v_agente_extravio_auditoria"] });
      qc.invalidateQueries({ queryKey: ["auditoria", "count-24h"] });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [qc]);

  const rows: AcaoUnificada[] = useMemo(() => {
    const r = (ressarcQuery.data ?? []).map<AcaoUnificada>((x, i) => ({
      key: `r-${x.id ?? `${x.card_id}-${i}`}`,
      card_id: x.card_id,
      nf: x.nf,
      operador: x.operador,
      agente: "ressarcimento_54",
      event_type: x.event_type,
      acao_label: "LANÇOU 54",
      tier: x.tier,
      descricao: x.descricao,
      created_at: x.created_at,
    }));
    const e = (extravioQuery.data ?? []).map<AcaoUnificada>((x, i) => ({
      key: `e-${x.id ?? `${x.card_id}-${i}`}`,
      card_id: x.card_id,
      nf: x.nf,
      operador: x.operador,
      agente: "extravio",
      event_type: x.event_type,
      acao_label: "LANÇOU OC 49",
      tier: null,
      descricao:
        x.descricao ??
        (x.oc_achada != null ? `oc achada: ${x.oc_achada}` : null),
      created_at: x.created_at,
    }));
    return [...r, ...e].sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );
  }, [ressarcQuery.data, extravioQuery.data]);

  const { data: count24h } = useQuery({
    queryKey: ["auditoria", "count-24h"],
    enabled: !!supabase,
    queryFn: async () => {
      const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [r, e] = await Promise.all([
        supabase!
          .from("v_ressarc54_auditoria")
          .select("*", { count: "exact", head: true })
          .gte("created_at", sinceISO),
        supabase!
          .from("v_agente_extravio_auditoria")
          .select("*", { count: "exact", head: true })
          .gte("created_at", sinceISO),
      ]);
      return (r.count ?? 0) + (e.count ?? 0);
    },
  });

  const isLoading = ressarcQuery.isLoading || extravioQuery.isLoading;
  const isError = ressarcQuery.isError || extravioQuery.isError;

  function rpcForAgente(a: AcaoUnificada["agente"]): string {
    return a === "ressarcimento_54"
      ? "reportar_erro_ressarc54"
      : "reportar_erro_agente_extravio";
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b-2 border-ink bg-paper px-6 py-3">
        <h1 className="font-display text-[20px] font-semibold">Auditoria</h1>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
          Snapshots congelados de ações autônomas
        </p>
      </header>

      <div className="flex-1 overflow-y-auto bg-paper-deep/30 p-6">
        <div className="mb-4 flex flex-wrap gap-1 border-b-2 border-ink">
          {([
            { id: "executadas", label: "🤖 Executadas (todas as fontes)" },
            { id: "janela_veto", label: "⏱ Janela de veto" },
            { id: "todos", label: "🤖 Ações 100% autônomas" },
            { id: "agente_extravio", label: "🤖 Agente de extravio" },
          ] as { id: Aba; label: string }[]).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setAba(t.id)}
              className={cn(
                "border-2 border-b-0 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest",
                aba === t.id
                  ? "border-ink bg-ink text-paper"
                  : "border-ink/30 bg-paper text-ink-soft hover:text-ink",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {aba === "executadas" ? (
          <PainelAutonomasSection />
        ) : aba === "janela_veto" ? (
          <>
            <div className="mb-4 flex flex-wrap gap-2">
              <select
                value={periodo}
                onChange={(e) => setPeriodo(e.target.value as Periodo)}
                className="border-2 border-ink bg-paper px-2 py-1 font-mono text-[11px] uppercase tracking-wider"
              >
                <option value="all">Tudo</option>
                <option value="24h">Últimas 24h</option>
                <option value="7d">7 dias</option>
                <option value="30d">30 dias</option>
              </select>
            </div>
            <JanelaVetoSection desdeISO={periodoToISO(periodo)} />
          </>
        ) : aba === "agente_extravio" ? (
          <AgenteExtravioSection />
        ) : (
          <>
            <div className="mb-4 inline-block border-2 border-ink bg-paper px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                Últimas 24h
              </div>
              <div className="mt-1 font-display text-[18px] font-semibold text-ink">
                {count24h ?? 0}{" "}
                {count24h === 1 ? "ação autônoma executada" : "ações autônomas executadas"}
              </div>
            </div>

            <div className="mb-4 flex flex-wrap gap-2">
              <select
                value={periodo}
                onChange={(e) => setPeriodo(e.target.value as Periodo)}
                className="border-2 border-ink bg-paper px-2 py-1 font-mono text-[11px] uppercase tracking-wider"
              >
                <option value="all">Tudo</option>
                <option value="24h">Últimas 24h</option>
                <option value="7d">7 dias</option>
                <option value="30d">30 dias</option>
              </select>
            </div>

            {isLoading ? (
              <div className="font-display italic text-ink-soft">Carregando…</div>
            ) : isError ? (
              <div className="font-mono text-[12px] text-sal">Erro ao carregar auditoria.</div>
            ) : rows.length === 0 ? (
              <div className="font-display italic text-ink-soft">
                Nenhuma ação autônoma no período.
              </div>
            ) : (
              <ul className="space-y-2">
                {rows.map((r) => {
                  const badge =
                    `${r.acao_label}` +
                    (r.tier ? ` · TIER ${r.tier}` : "") +
                    ` · AUTÔNOMO`;
                  return (
                    <li key={r.key}>
                      <div className="flex items-start justify-between gap-3 border-2 border-ink bg-paper px-4 py-3">
                        <div className="min-w-0">
                          <div className="font-display text-[14px] font-semibold text-ink">
                            NF {r.nf ?? "—"}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center border-2 border-ink bg-emerald-200 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-ink">
                              ✓ {badge}
                            </span>
                            <span className="font-mono text-[11px] text-ink-soft">
                              {r.operador ?? "—"}
                            </span>
                          </div>
                          {r.descricao && (
                            <div className="mt-1 font-mono text-[11px] text-ink">
                              {r.descricao}
                            </div>
                          )}
                          <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                            {relativeShort(r.created_at)}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <Link
                            to={`/cards/${r.card_id}`}
                            className="border-2 border-ink bg-paper px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:bg-ink hover:text-paper"
                          >
                            Ver card →
                          </Link>
                          <BotaoReportarErroAgente
                            cardId={r.card_id}
                            rpcName={rpcForAgente(r.agente)}
                            size="xs"
                            onReported={() => {
                              ressarcQuery.refetch();
                              extravioQuery.refetch();
                            }}
                          />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
