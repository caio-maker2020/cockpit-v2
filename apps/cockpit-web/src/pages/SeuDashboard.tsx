// =============================================================================
// SEU DASHBOARD — a visão do PRÓPRIO operador (plano máquina-de-visão, 21/08).
// Uma aba só (pra ser olhada de verdade), 2 módulos: SEUS NÚMEROS (operação)
// e SEUS AGENTES (sugestões que você aprova). Sempre: você × média do time.
// Dados via RPCs seguras da mig 344 — devolvem SÓ os agregados do próprio
// operador + a média geral; nunca linhas dos colegas.
// =============================================================================
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { SecaoDobravel } from "@/components/aprendizado/SecaoDobravel";
import { AGENTES_CATALOGO, agenteAmigavel } from "@/lib/agentesCatalogo";

function Kpi({ rotulo, valor, media, invertido }: {
  rotulo: string;
  valor: string;
  media?: string;
  /** true quando MENOR é melhor (ex.: tempo) */
  invertido?: boolean;
}) {
  return (
    <div className="ticket-card px-5 py-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.13em] text-ink-mute">{rotulo}</div>
      <div className="mt-1 text-[26px] font-bold leading-none tabular text-ink-2">{valor}</div>
      {media && (
        <div className="mt-1 text-[12px] text-ink-soft-2">
          média do time: <strong>{media}</strong>{invertido ? " · menor é melhor" : ""}
        </div>
      )}
    </div>
  );
}

interface RowOperacao {
  tratadas: number;
  minhas_ate_2h_pct: number | null;
  time_ate_2h_pct: number | null;
  minhas_horas_uteis_media: number | null;
  time_horas_uteis_media: number | null;
  paradas_mais_1d_util: number;
}

interface RowAgente {
  agent_name: string;
  oc_sugerida: number | null;
  oc_card?: number | null;
  meus_pares: number;
  minhas_seguidas: number;
  meu_pct: number | null;
  time_pct: number | null;
}

export default function SeuDashboard() {
  const { operador, loading } = useAuth();

  const operacao = useQuery({
    queryKey: ["seu-dashboard-operacao"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("meu_dashboard_operacao", { p_dias: 30 });
      if (error) throw error;
      return ((data ?? []) as RowOperacao[])[0] ?? null;
    },
    enabled: !!operador,
    staleTime: 60_000,
    retry: false,
  });

  const agentes = useQuery({
    queryKey: ["seu-dashboard-agentes"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("meu_dashboard_agentes", { p_dias: 30 });
      if (error) throw error;
      return (data ?? []) as RowAgente[];
    },
    enabled: !!operador,
    staleTime: 60_000,
    retry: false,
  });

  if (loading) return null;

  const op = operacao.data;
  const indisponivel = operacao.isError || agentes.isError;
  const primeiroNome = (operador?.nome ?? "").split(" ")[0] || "você";

  return (
    <div className="mx-auto max-w-5xl px-6 pb-24 pt-8">
      <header className="mb-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-sal">Seu dashboard</div>
        <h1 className="mt-1 text-[26px] font-bold leading-tight text-ink-2">Seus últimos 30 dias, {primeiroNome}</h1>
        <p className="mt-1 text-[13px] text-ink-soft-2">
          Só os seus números e os seus clientes — comparados com a média do time. Tempo conta em <strong>horas úteis</strong> (08h–17h30).
        </p>
      </header>

      {indisponivel && (
        <div className="mb-6 rounded-lg border px-4 py-3 text-[13px]" style={{ borderColor: "var(--warning)", background: "var(--warning-soft)", color: "var(--warning)" }}>
          Os números ainda não estão disponíveis (migração pendente) — em breve aparecem aqui.
        </div>
      )}

      {/* MÓDULO 1 — SEUS NÚMEROS */}
      <SecaoDobravel id="seu-dash-numeros" titulo="Seus números">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi rotulo="Cards tratados" valor={op ? String(op.tratadas) : "—"} />
          <Kpi
            rotulo="Tratados em ≤2h úteis"
            valor={op?.minhas_ate_2h_pct != null ? `${op.minhas_ate_2h_pct}%` : "—"}
            media={op?.time_ate_2h_pct != null ? `${op.time_ate_2h_pct}%` : undefined}
          />
          <Kpi
            rotulo="Seu tempo médio na fila"
            valor={op?.minhas_horas_uteis_media != null ? `${op.minhas_horas_uteis_media}h` : "—"}
            media={op?.time_horas_uteis_media != null ? `${op.time_horas_uteis_media}h` : undefined}
            invertido
          />
          <Kpi rotulo="Parados >1 dia útil agora" valor={op ? String(op.paradas_mais_1d_util) : "—"} />
        </div>
        {op && op.minhas_ate_2h_pct != null && op.time_ate_2h_pct != null && op.minhas_ate_2h_pct < op.time_ate_2h_pct && (
          <p className="mt-3 rounded-lg px-4 py-2.5 text-[13px]" style={{ background: "var(--warning-soft)", color: "var(--warning)" }}>
            Você está tratando em 2h menos vezes que a média do time ({op.minhas_ate_2h_pct}% × {op.time_ate_2h_pct}%) — vale olhar a fila mais cedo no dia.
          </p>
        )}
      </SecaoDobravel>

      {/* MÓDULO 2 — SEUS AGENTES */}
      <SecaoDobravel id="seu-dash-agentes" titulo="Seus agentes">
        <p className="mb-3 text-[12.5px] text-ink-soft-2">
          De cada sugestão que os agentes fizeram <strong>nos seus cards</strong>, quantas você aprovou exatamente igual? Quando o seu número foge muito da média do agente, vale conversar com a gestão — ou o agente erra nos seus clientes, ou há um jeito diferente de tratar.
        </p>
        <div className="space-y-2">
          {(agentes.data ?? []).map((a) => {
            const abaixo = a.meu_pct != null && a.time_pct != null && a.meu_pct < a.time_pct - 10;
            return (
              <div key={`${a.agent_name}-${a.oc_card}-${a.oc_sugerida}`} className="ticket-card flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-ink-2">
                    {agenteAmigavel(a.agent_name)}
                    {a.oc_card != null && <span className="font-mono text-ink-soft-2"> · card em oc {a.oc_card}</span>}
                    {a.oc_sugerida != null && <span className="font-mono text-ink-soft-2"> → sugere oc {a.oc_sugerida}</span>}
                  </p>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                    {AGENTES_CATALOGO[a.agent_name]?.oQueFaz.slice(0, 70) ?? ""}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span className={`font-mono text-[18px] font-bold tabular ${abaixo ? "text-signal" : "text-ink-2"}`}>
                    {a.meu_pct != null ? `${a.meu_pct}%` : "—"}
                  </span>
                  <p className="font-mono text-[10px] text-ink-mute">
                    você ({a.minhas_seguidas}/{a.meus_pares}) · agente no time: {a.time_pct ?? "—"}%
                  </p>
                </div>
              </div>
            );
          })}
          {!agentes.isLoading && (agentes.data ?? []).length === 0 && !indisponivel && (
            <p className="py-4 text-center text-[13px] text-ink-mute">Sem sugestões avaliadas nos seus cards nos últimos 30 dias.</p>
          )}
        </div>
      </SecaoDobravel>
    </div>
  );
}
