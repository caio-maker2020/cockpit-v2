// =============================================================================
// GESTÃO AGENTES — visão dos agentes com um único norte: Objetivo 1 = 95% das
// sugestões seguidas pelos operadores (plano máquina-de-visão, Caio 21/08).
//
// Só gestores (Caio/João/Isadora) — operador tem o "Seu Dashboard".
// Fontes: views da mig 344 (v_gestao_agentes_placar / _divergencias /
// v_acoes_cockpit / v_melhorias_impacto). Sem a migration aplicada, a página
// avisa e não quebra (padrão PlacarAgentes).
// =============================================================================
import { useMemo, useState } from "react";
import { Navigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

import { supabase } from "@/lib/supabase";
import { useAuth, useIsGestor } from "@/contexts/AuthContext";
import { SecaoDobravel } from "@/components/aprendizado/SecaoDobravel";
import { AGENTES_CATALOGO, agenteAmigavel } from "@/lib/agentesCatalogo";
import { DicaHover } from "@/components/gestao/DicaHover";
import {
  diaBrtAtras, filtrarPlacar, matrizDivergencia, porAgente, porFatia,
  seriePorDia, somarPlacar,
  type LinhaDivergencia, type LinhaPlacarGestao,
} from "@/lib/gestaoAgentes";

const META_PCT = 95;

// ---------- pedacinhos de UI ----------

function InfoAgente({ agente }: { agente: string }) {
  const info = AGENTES_CATALOGO[agente];
  if (!info) return null;
  return (
    <span className="ml-1 align-middle">
      <DicaHover
        dica={
          <>
            <strong className="text-ink-2">{info.nome}</strong>
            <br />O que faz: {info.oQueFaz}
            <br />O que sugere: {info.oQueSugere}
          </>
        }
      />
    </span>
  );
}

function Kpi({ rotulo, valor, sub, destaque }: { rotulo: string; valor: string; sub?: string; destaque?: "ok" | "ruim" }) {
  return (
    <div className="ticket-card px-5 py-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.13em] text-ink-mute">{rotulo}</div>
      <div className={`mt-1 text-[28px] font-bold leading-none tabular ${destaque === "ok" ? "text-positive" : destaque === "ruim" ? "text-signal" : "text-ink-2"}`}>
        {valor}
      </div>
      {sub && <div className="mt-1 text-[12px] text-ink-soft-2">{sub}</div>}
    </div>
  );
}

function BarraMeta({ pct }: { pct: number | null }) {
  const v = pct ?? 0;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-subtle">
      <div
        className={`h-full rounded-full ${v >= META_PCT ? "bg-positive-soft" : ""}`}
        style={{ width: `${Math.min(100, v)}%`, backgroundColor: v >= META_PCT ? "var(--positive)" : "var(--signal)" }}
      />
      <div className="absolute top-0 h-full w-px bg-ink" style={{ left: `${META_PCT}%` }} title={`Meta ${META_PCT}%`} />
    </div>
  );
}

const PERIODOS = [
  { id: "7", rotulo: "7 dias", dias: 7 },
  { id: "30", rotulo: "30 dias", dias: 30 },
  { id: "90", rotulo: "90 dias", dias: 90 },
] as const;

// Termos na língua do Cockpit (auditoria do Caio 21/08: "nunca vi esses
// termos") — cada card do D3 explica no "?" o que o número significa.
const D3_TIPOS: Record<string, { rotulo: string; dica: string }> = {
  aprovacao: {
    rotulo: "Aprovações (1 clique)",
    dica: "Operador clicou em Aprovar numa ação proposta pelo agente — a execução (SSW/e-mail) saiu sozinha.",
  },
  rejeicao: {
    rotulo: "Rejeições",
    dica: "Operador clicou em Rejeitar a proposta do agente (com motivo). Vira aprendizado.",
  },
  aprovacao_emergencial: {
    rotulo: "Lançamentos emergenciais",
    dica: "Botão 'lançar oc emergencial' do card: o operador lançou uma oc direto, sem proposta do agente na frente. É raro por construção.",
  },
  auto_aprovacao: {
    rotulo: "Aprovadas pelo agente sozinho",
    dica: "Regras 100% automáticas (ex.: exceções combinadas com cliente) em que o agente aprova sem humano. Hoje é pouquíssimo — é exatamente o que o Objetivo 1 quer expandir com segurança.",
  },
  lancamento_ssw: {
    rotulo: "Lançamentos no SSW",
    dica: "Ocorrências efetivamente lançadas no SSW pelo Cockpit (após aprovação).",
  },
  email_enviado: {
    rotulo: "E-mails enviados",
    dica: "E-mails de tratativa enviados ao cliente pelo Cockpit.",
  },
  interpretacao_email: {
    rotulo: "E-mails interpretados",
    dica: "Respostas de clientes lidas e interpretadas pela IA (viram sugestão no card).",
  },
  cancelamento_reentrega: {
    rotulo: "Canc. de reentrega",
    dica: "Cancelamentos de reentrega agendados/tratados via Cockpit.",
  },
};

// ---------- página ----------

export default function GestaoAgentes() {
  const { loading } = useAuth();
  const isGestor = useIsGestor();

  const [periodo, setPeriodo] = useState<string>("30");
  const [d2Visao, setD2Visao] = useState<"grafico" | "lista">("grafico");
  const [agente, setAgente] = useState<string>("");
  const [operadorId, setOperadorId] = useState<string>("");

  const dias = PERIODOS.find((p) => p.id === periodo)?.dias ?? 30;
  const diaInicio = useMemo(() => diaBrtAtras(dias), [dias]);

  const placar = useQuery({
    queryKey: ["gestao-agentes-placar", diaInicio],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_gestao_agentes_placar").select("*").gte("dia", diaInicio).limit(20000);
      if (error) throw error;
      return (data ?? []) as LinhaPlacarGestao[];
    },
    enabled: isGestor,
    staleTime: 60_000,
    retry: false,
  });

  const diverg = useQuery({
    queryKey: ["gestao-agentes-diverg", diaInicio],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_gestao_agentes_divergencias").select("*").gte("dia", diaInicio).limit(20000);
      if (error) throw error;
      return (data ?? []) as LinhaDivergencia[];
    },
    enabled: isGestor,
    staleTime: 60_000,
    retry: false,
  });

  const acoes = useQuery({
    queryKey: ["gestao-agentes-acoes", diaInicio, operadorId],
    queryFn: async () => {
      let q = supabase.from("v_acoes_cockpit").select("*").gte("dia", diaInicio).limit(20000);
      if (operadorId) q = q.eq("operador_id", operadorId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Array<{ dia: string; tipo: string | null; operador_id: string | null; n: number }>;
    },
    enabled: isGestor,
    staleTime: 60_000,
    retry: false,
  });

  const melhorias = useQuery({
    queryKey: ["gestao-agentes-melhorias"],
    queryFn: async () => {
      const { data, error } = await supabase.from("v_melhorias_impacto").select("*").limit(200);
      if (error) throw error;
      return (data ?? []) as Array<{
        melhoria_id: string; titulo: string | null; agente_alvo: string | null; oc_sugerida: number | null;
        mergeado_em: string; status: string; pares_pre: number; seguidas_pre: number;
        pares_pos: number; seguidas_pos: number; pct_pre: number | null; pct_pos: number | null;
      }>;
    },
    enabled: isGestor,
    staleTime: 60_000,
    retry: false,
  });

  const operadores = useQuery({
    queryKey: ["gestao-agentes-operadores"],
    queryFn: async () => {
      const { data } = await supabase
        .from("operadores").select("id, nome").eq("cockpit_ativo", true).order("nome");
      return (data ?? []) as Array<{ id: string; nome: string }>;
    },
    enabled: isGestor,
    staleTime: 5 * 60_000,
  });

  const filtro = { agente: agente || null, operadorId: operadorId || null };
  const linhasFiltradas = useMemo(() => filtrarPlacar(placar.data ?? [], filtro), [placar.data, agente, operadorId]);
  const divergFiltradas = useMemo(
    () => filtrarPlacar(diverg.data ?? [], filtro) as LinhaDivergencia[],
    [diverg.data, agente, operadorId],
  );
  const totais = useMemo(() => somarPlacar(linhasFiltradas), [linhasFiltradas]);
  const serie = useMemo(() => seriePorDia(linhasFiltradas), [linhasFiltradas]);
  const agentes = useMemo(() => porAgente(linhasFiltradas), [linhasFiltradas]);
  const fatias = useMemo(() => porFatia(linhasFiltradas).filter((f) => f.pares >= 5), [linhasFiltradas]);
  const matriz = useMemo(() => matrizDivergencia(divergFiltradas).slice(0, 15), [divergFiltradas]);
  const matrizGrafico = useMemo(
    () => matriz.slice(0, 10).map((m) => ({
      rotulo: `${m.oc_sugerida}→${m.oc_executada}`,
      agente: agenteAmigavel(m.agent_name),
      n: m.n,
    })),
    [matriz],
  );
  const totalDiverg = useMemo(() => matriz.reduce((a, m) => a + m.n, 0), [matriz]);
  const acoesPorTipo = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of acoes.data ?? []) if (a.tipo) m.set(a.tipo, (m.get(a.tipo) ?? 0) + a.n);
    return [...m.entries()].sort((x, y) => y[1] - x[1]);
  }, [acoes.data]);

  if (loading) return null;
  if (!isGestor) return <Navigate to="/inbox" replace />;

  const migPendente = placar.isError || diverg.isError;

  return (
    <div className="mx-auto max-w-6xl px-6 pb-24 pt-8">
      <header className="mb-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-sal">Gestão · Agentes</div>
        <h1 className="mt-1 text-[26px] font-bold leading-tight text-ink-2">
          De cada 100 sugestões, quantas o operador seguiu exatamente?
        </h1>
        <p className="mt-1 text-[13px] text-ink-soft-2">
          Meta: <strong>{META_PCT}%</strong> seguidas. Tudo nesta tela existe pra achar onde a confiança ainda não chegou lá.
        </p>
      </header>

      {migPendente && (
        <div className="mb-6 rounded-lg border px-4 py-3 text-[13px]" style={{ borderColor: "var(--warning)", background: "var(--warning-soft)", color: "var(--warning)" }}>
          As views da Fase 1 (migration 344) ainda não foram aplicadas em produção — os números aparecem depois da aplicação.
        </div>
      )}

      {/* Filtros */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-rule">
          {PERIODOS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPeriodo(p.id)}
              className={`px-3 py-1.5 text-[12px] font-medium ${periodo === p.id ? "bg-ink text-white" : "bg-surface text-ink-soft-2 hover:bg-subtle"}`}
            >
              {p.rotulo}
            </button>
          ))}
        </div>
        <select
          value={agente}
          onChange={(e) => setAgente(e.target.value)}
          className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-[12px] text-ink-2"
        >
          <option value="">Todos os agentes</option>
          {Object.keys(AGENTES_CATALOGO).map((a) => (
            <option key={a} value={a}>{agenteAmigavel(a)}</option>
          ))}
        </select>
        <select
          value={operadorId}
          onChange={(e) => setOperadorId(e.target.value)}
          className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-[12px] text-ink-2"
        >
          <option value="">Todos os operadores</option>
          {(operadores.data ?? []).map((o) => (
            <option key={o.id} value={o.id}>{o.nome}</option>
          ))}
        </select>
      </div>

      {/* D1 — acerto vs erro */}
      <SecaoDobravel id="gestao-ag-d1" titulo="Acerto das sugestões" padraoAberto>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi
            rotulo="Seguidas exatamente"
            valor={totais.pctAcerto != null ? `${totais.pctAcerto}%` : "—"}
            sub={`${totais.seguidas} de ${totais.pares} sugestões`}
            destaque={totais.pctAcerto != null ? (totais.pctAcerto >= META_PCT ? "ok" : "ruim") : undefined}
          />
          <Kpi rotulo="Corrigidas pelo operador" valor={String(totais.corrigidas)} sub="operador fez diferente" destaque={totais.corrigidas > 0 ? "ruim" : undefined} />
          <Kpi rotulo="Abstenções" valor={String(totais.abstencoes)} sub="agente não sugeriu" />
          <Kpi rotulo="Faltam pra meta" valor={totais.pctAcerto != null ? `${Math.max(0, Math.round((META_PCT - totais.pctAcerto) * 10) / 10)} pts` : "—"} sub={`meta ${META_PCT}%`} />
        </div>
        {serie.length > 1 && (
          <div className="ticket-card mt-3 px-4 py-4">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={serie} margin={{ top: 6, right: 12, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="dia" tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }} tickFormatter={(d: string) => d.slice(5)} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }} />
                <Tooltip formatter={(v: number) => [`${v}%`, "seguidas"]} labelFormatter={(d) => `Dia ${d}`} />
                <ReferenceLine y={META_PCT} stroke="var(--positive)" strokeDasharray="4 4" label={{ value: `meta ${META_PCT}%`, fontSize: 10, fill: "var(--positive)", position: "insideTopRight" }} />
                <Line type="monotone" dataKey="pct" stroke="var(--signal)" strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="mt-3 space-y-2">
          {agentes.map((a) => (
            <div key={a.agent_name} className="ticket-card flex items-center gap-4 px-4 py-3">
              <div className="w-56 shrink-0">
                <span className="text-[13px] font-semibold text-ink-2">{agenteAmigavel(a.agent_name)}</span>
                <InfoAgente agente={a.agent_name} />
              </div>
              <div className="flex-1"><BarraMeta pct={a.pctAcerto} /></div>
              <div className="w-40 shrink-0 text-right font-mono text-[12px] tabular text-ink-soft-2">
                <strong className="text-ink-2">{a.pctAcerto != null ? `${a.pctAcerto}%` : "—"}</strong>
                {` · ${a.seguidas}/${a.pares}`}
              </div>
            </div>
          ))}
          {!placar.isLoading && agentes.length === 0 && !migPendente && (
            <div className="py-6 text-center text-[13px] text-ink-mute">Sem pares no período/filtros.</div>
          )}
        </div>
      </SecaoDobravel>

      {/* D2 — onde está a confusão: DASHBOARD primeiro, lista opcional */}
      <SecaoDobravel id="gestao-ag-d2" titulo="Onde está a confusão (sugerido → executado)" padraoAberto>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[12.5px] text-ink-soft-2">
            {totalDiverg > 0 && matrizGrafico[0]
              ? <>O par <strong className="font-mono text-ink-2">oc {matrizGrafico[0].rotulo}</strong> ({matrizGrafico[0].agente}) concentra <strong>{Math.round((100 * (matriz[0]?.n ?? 0)) / totalDiverg)}%</strong> da divergência do período — é onde a energia rende mais.</>
              : "Sem divergências no período/filtros."}
          </p>
          <div className="flex overflow-hidden rounded-lg border border-rule">
            {(["grafico", "lista"] as const).map((v) => (
              <button key={v} onClick={() => setD2Visao(v)}
                className={`px-3 py-1 text-[11px] font-medium ${d2Visao === v ? "bg-ink text-white" : "bg-surface text-ink-soft-2 hover:bg-subtle"}`}>
                {v === "grafico" ? "Gráfico" : "Ver lista"}
              </button>
            ))}
          </div>
        </div>

        {d2Visao === "grafico" && matrizGrafico.length > 0 && (
          <div className="ticket-card px-4 py-4">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
              Top pares de divergência — nº de vezes que o operador trocou a sugestão
            </p>
            <ResponsiveContainer width="100%" height={Math.max(200, matrizGrafico.length * 34)}>
              <BarChart data={matrizGrafico} layout="vertical" margin={{ top: 0, right: 44, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }} allowDecimals={false} />
                <YAxis type="category" dataKey="rotulo" width={72} tick={{ fontSize: 11, fill: "var(--c-ink)", fontFamily: "IBM Plex Mono" }} />
                <Tooltip formatter={(v: number) => [`${v}×`, "trocas"]} labelFormatter={(l, payload) => `oc ${l} · ${(payload?.[0]?.payload as { agente?: string })?.agente ?? ""}`} />
                <Bar dataKey="n" radius={[0, 6, 6, 0]}>
                  <LabelList dataKey="n" position="right" style={{ fontSize: 11, fill: "var(--c-ink-soft)" }} />
                  {matrizGrafico.map((_, i) => (
                    <Cell key={i} fill={i === 0 ? "var(--signal)" : "var(--c-ink-mute)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {d2Visao === "lista" && (
          <div className="ticket-card overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-rule font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                  <th className="px-4 py-2.5">Agente</th>
                  <th className="px-4 py-2.5">Sugeriu</th>
                  <th className="px-4 py-2.5">Operador fez</th>
                  <th className="px-4 py-2.5 text-right">Vezes</th>
                  <th className="px-4 py-2.5">Último caso</th>
                  <th className="px-4 py-2.5">Exemplos</th>
                </tr>
              </thead>
              <tbody>
                {matriz.map((m) => (
                  <tr key={`${m.agent_name}-${m.oc_sugerida}-${m.oc_executada}`} className="border-b border-rule last:border-0">
                    <td className="px-4 py-2.5 text-ink-soft-2">{agenteAmigavel(m.agent_name)}<InfoAgente agente={m.agent_name} /></td>
                    <td className="px-4 py-2.5 font-mono font-semibold text-ink-2">oc {m.oc_sugerida}</td>
                    <td className="px-4 py-2.5 font-mono font-semibold text-signal">oc {m.oc_executada}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular text-ink-2">{m.n}×</td>
                    <td className="px-4 py-2.5 text-[12px] text-ink-mute">{new Date(m.ultimo_em).toLocaleDateString("pt-BR")}</td>
                    <td className="px-4 py-2.5">
                      {m.cards_exemplo.slice(0, 3).map((c, i) => (
                        <Link key={c} to={`/cards/${c}`} className="mr-2 font-mono text-[11px] text-sal underline-offset-2 hover:underline">
                          caso {i + 1}
                        </Link>
                      ))}
                    </td>
                  </tr>
                ))}
                {matriz.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-ink-mute">Sem divergências no período/filtros. 🎯</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </SecaoDobravel>

      {/* D3 — ações executadas pelo Cockpit (termos do dia a dia + "?") */}
      <SecaoDobravel id="gestao-ag-d3" titulo="Ações executadas pelo Cockpit" padraoAberto={false}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {acoesPorTipo.map(([tipo, n]) => {
            const info = D3_TIPOS[tipo] ?? { rotulo: tipo, dica: "" };
            return (
              <div key={tipo} className="ticket-card px-5 py-4">
                <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.13em] text-ink-mute">
                  {info.rotulo}
                  {info.dica && <DicaHover dica={info.dica} />}
                </div>
                <div className="mt-1 text-[28px] font-bold leading-none tabular text-ink-2">{n.toLocaleString("pt-BR")}</div>
              </div>
            );
          })}
          {acoesPorTipo.length === 0 && !acoes.isLoading && (
            <div className="col-span-full py-6 text-center text-[13px] text-ink-mute">Sem dados no período.</div>
          )}
        </div>
      </SecaoDobravel>

      {/* D4 — placar por fatia */}
      <SecaoDobravel id="gestao-ag-d4" titulo="Placar por fatia (agente + ocorrência sugerida)" padraoAberto={false}>
        <div className="space-y-2">
          {fatias.map((f) => (
            <div key={`${f.agent_name}-${f.oc_sugerida}`} className="ticket-card flex items-center gap-4 px-4 py-2.5">
              <div className="w-64 shrink-0 text-[12.5px] text-ink-soft-2">
                {agenteAmigavel(f.agent_name)} · <span className="font-mono font-semibold text-ink-2">sugere oc {f.oc_sugerida ?? "—"}</span>
              </div>
              <div className="flex-1"><BarraMeta pct={f.pctAcerto} /></div>
              <div className="w-36 shrink-0 text-right font-mono text-[12px] tabular text-ink-soft-2">
                <strong className="text-ink-2">{f.pctAcerto != null ? `${f.pctAcerto}%` : "—"}</strong>
                {` · ${f.seguidas}/${f.pares}`}
              </div>
            </div>
          ))}
          {fatias.length === 0 && <div className="py-6 text-center text-[13px] text-ink-mute">Sem fatias com ≥5 pares no período.</div>}
        </div>
      </SecaoDobravel>

      {/* D5 — melhorias em produção */}
      <SecaoDobravel id="gestao-ag-d5" titulo="Melhorias em produção — antes × depois" padraoAberto>
        <div className="grid gap-3 md:grid-cols-2">
          {(melhorias.data ?? []).map((m) => (
            <div key={m.melhoria_id} className="ticket-card px-5 py-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                {agenteAmigavel(m.agente_alvo ?? "")} {m.oc_sugerida != null ? `· oc ${m.oc_sugerida}` : ""} · merge {new Date(m.mergeado_em).toLocaleDateString("pt-BR")}
              </div>
              <div className="mt-1 text-[13.5px] font-semibold text-ink-2">{m.titulo ?? "Melhoria"}</div>
              <div className="mt-3 flex items-center gap-3 font-mono tabular">
                <span className="text-[22px] font-bold text-ink-mute">{m.pct_pre != null ? `${m.pct_pre}%` : "—"}</span>
                <span className="text-ink-mute">→</span>
                <span className={`text-[22px] font-bold ${m.pct_pos != null && m.pct_pre != null && m.pct_pos >= m.pct_pre ? "text-positive" : "text-signal"}`}>
                  {m.pct_pos != null ? `${m.pct_pos}%` : "—"}
                </span>
                <span className="text-[11px] text-ink-mute">({m.pares_pre} antes · {m.pares_pos} depois)</span>
              </div>
            </div>
          ))}
          {!melhorias.isLoading && (melhorias.data ?? []).length === 0 && (
            <div className="col-span-full py-6 text-center text-[13px] text-ink-mute">
              Nenhuma melhoria mergeada ainda — quando o ciclo da Fase 4 rodar, o antes×depois aparece aqui.
            </div>
          )}
        </div>
      </SecaoDobravel>
    </div>
  );
}
