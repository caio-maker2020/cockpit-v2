import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/lib/supabase";
import { diasUteisFechados, JANELA_PLACAR_UTEIS } from "@/lib/aprendizadoPlacar";
import {
  agregarPlacar,
  META_ACERTO_PCT,
  type LinhaErro,
  type LinhaPlacar,
} from "@/lib/placarAgentes";

// Placar dos agentes (Caio 2026-08-13). Uma pergunta só: o operador fez
// exatamente o que o agente sugeriu? Cada divergência é caso do loop de
// melhoria. Fatia que passa de 95% vira candidata a autônoma.
//
// Fonte: v_placar_agente / v_placar_agente_erros (mig 338). Se a migration
// ainda não rodou, o componente se cala em vez de quebrar a aba.

const AGENTE_AMIGAVEL: Record<string, string> = {
  "agente-sugere-ocs-padrao": "Sugestão de ocorrência",
  "interpretador-resposta-cliente": "Leitura da resposta do cliente",
  "agente-oc13-autonomo": "Exceções oc 13",
  "scan-email-pre-card": "Varredura de e-mail",
  "robo-intranet-wurth": "Robô intranet Würth",
};

export function PlacarAgentes() {
  const placar = useQuery({
    queryKey: ["placar-agentes", "linhas"],
    enabled: !!supabase,
    staleTime: 5 * 60_000,
    retry: false, // view ausente (migration não aplicada) não fica repetindo
    queryFn: async (): Promise<LinhaPlacar[]> => {
      const desde = diasUteisFechados(JANELA_PLACAR_UTEIS * 2, new Date()).at(-1);
      const { data, error } = await supabase!
        .from("v_placar_agente")
        .select("dia, agent_name, fatia_oc_sugerida, seguidas, corrigidas, pares")
        .gte("dia", desde ?? "1970-01-01")
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as LinhaPlacar[];
    },
  });

  const erros = useQuery({
    queryKey: ["placar-agentes", "erros"],
    enabled: !!supabase,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<LinhaErro[]> => {
      const { data, error } = await supabase!
        .from("v_placar_agente_erros")
        .select("agent_name, oc_sugerida, oc_executada, n")
        .order("n", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as LinhaErro[];
    },
  });

  const dados = useMemo(
    () => agregarPlacar(placar.data ?? [], erros.data ?? [], new Date()),
    [placar.data, erros.data],
  );

  // Migration ainda não aplicada: não polui a aba com erro vermelho.
  if (placar.isError) return null;
  if (placar.isLoading) {
    return <div className="h-40 animate-pulse rounded-xl border border-border bg-bg-elevated" />;
  }
  if (dados.agentes.length === 0) return null;

  const g = dados.global;
  const faltam = g.pct !== null ? Math.round((META_ACERTO_PCT - g.pct) * 10) / 10 : null;

  return (
    <section aria-label="Placar dos agentes" className="mb-8">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-mute">
          Placar dos agentes · {JANELA_PLACAR_UTEIS} dias úteis
        </p>
        <p className="text-[11px] text-ink-mute">
          o operador fez exatamente o que o agente sugeriu?
        </p>
      </div>

      {/* ---- O número + a distância da meta ---- */}
      <div className="mb-3 rounded-xl border border-border-strong bg-bg-elevated p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[42px] font-semibold leading-none tabular-nums text-ink">
                {g.pct !== null ? `${g.pct}%` : "—"}
              </span>
              {g.delta !== null && (
                <span
                  className={`font-mono text-[13px] font-semibold tabular-nums ${
                    g.delta > 0 ? "text-positive" : g.delta < 0 ? "text-negative" : "text-ink-mute"
                  }`}
                >
                  {g.delta > 0 ? "▲" : g.delta < 0 ? "▼" : "="} {Math.abs(g.delta).toFixed(1)}
                </span>
              )}
            </div>
            <p className="mt-1 text-[12px] text-ink-soft">
              {faltam !== null && faltam > 0
                ? `Faltam ${faltam} pontos — ${dados.acoesParaMeta} ações por semana ainda divergem.`
                : "Meta batida."}
            </p>
          </div>
          <div className="min-w-[180px] flex-1">
            <div className="relative h-2 w-full rounded-full bg-bg-muted">
              <div
                className="h-full rounded-full bg-ink"
                style={{ width: `${Math.min(100, Math.max(1, g.pct ?? 0))}%` }}
              />
              <div
                className="absolute -top-1 bottom-[-4px] w-[2px] rounded bg-signal"
                style={{ left: `${META_ACERTO_PCT}%` }}
                aria-hidden
              />
            </div>
            <p className="mt-1 text-right font-mono text-[10px] text-signal">meta {META_ACERTO_PCT}%</p>
          </div>
        </div>
      </div>

      {/* ---- Por agente ---- */}
      <div className="space-y-1.5">
        {dados.agentes.map((a) => (
          <div
            key={a.agente}
            className="grid grid-cols-[minmax(0,1fr),96px] items-center gap-3 rounded-xl border border-border bg-bg-elevated px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-[13px] font-semibold text-ink">
                  {AGENTE_AMIGAVEL[a.agente] ?? a.agente}
                </span>
                {a.pct !== null && a.pct >= META_ACERTO_PCT ? (
                  <span className="rounded border border-positive/30 bg-positive/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-positive">
                    pronto p/ autonomia
                  </span>
                ) : a.pct !== null ? (
                  <span className="rounded border border-signal/25 bg-signal-soft px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-signal">
                    {Math.round(META_ACERTO_PCT - a.pct)} pts da meta
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 font-mono text-[11px] tabular-nums text-ink-mute">
                {a.pares} ações · {a.seguidas} seguidas · {a.corrigidas} diferentes
                {a.piorErro && (
                  <span className="text-ink-soft">
                    {" · "}erra mais em {a.piorErro.oc_sugerida}→{a.piorErro.oc_executada} ({a.piorErro.n}x)
                  </span>
                )}
              </p>
              <div className="relative mt-2 h-1.5 w-full rounded-full bg-bg-muted">
                <div
                  className={`h-full rounded-full ${
                    a.pct !== null && a.pct >= META_ACERTO_PCT ? "bg-positive" : "bg-ink"
                  }`}
                  style={{ width: `${Math.min(100, Math.max(1, a.pct ?? 0))}%` }}
                />
                <div
                  className="absolute -top-0.5 bottom-[-2px] w-[2px] rounded bg-signal"
                  style={{ left: `${META_ACERTO_PCT}%` }}
                  aria-hidden
                />
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono text-[22px] font-semibold leading-none tabular-nums text-ink">
                {a.pct !== null ? `${a.pct}%` : "—"}
              </div>
              {a.delta !== null && (
                <div
                  className={`mt-1 font-mono text-[11px] font-semibold tabular-nums ${
                    a.delta > 0 ? "text-positive" : a.delta < 0 ? "text-negative" : "text-ink-mute"
                  }`}
                >
                  {a.delta > 0 ? "▲" : a.delta < 0 ? "▼" : "="} {Math.abs(a.delta).toFixed(1)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ---- Fatias prontas: o caminho concreto pra autonomia ---- */}
      {dados.fatiasProntas.length > 0 && (
        <div className="mt-3 rounded-xl border border-positive/25 bg-positive/5 px-4 py-3">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-positive">
            Fatias já em {META_ACERTO_PCT}%+
          </p>
          <p className="mt-1 text-[12px] text-ink-soft">
            {dados.fatiasProntas.map((f, i) => (
              <span key={`${f.agente}-${f.oc}`}>
                {i > 0 && " · "}
                <b className="text-ink">
                  {AGENTE_AMIGAVEL[f.agente] ?? f.agente} → oc {f.oc}
                </b>{" "}
                <span className="font-mono tabular-nums">
                  {f.pct}% ({f.pares})
                </span>
              </span>
            ))}
          </p>
        </div>
      )}
    </section>
  );
}
