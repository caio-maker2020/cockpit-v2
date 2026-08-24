// =============================================================================
// GESTÃO OPERADORES — a operação humana medida (plano máquina-de-visão, 21/08).
// Só gestores. Fontes: v_operador_tratativas / v_operador_fila_agora /
// v_acoes_cockpit / marcadores_processo_operador (migs 344/345) + o bloco de
// Erros de Lançamento por Base (migrado da antiga aba Indicadores).
// Janela útil: 08h–17h30 BRT — quem recebeu card às 19h não é penalizado.
// =============================================================================
import { useMemo, useState } from "react";
import { Navigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

import { supabase } from "@/lib/supabase";
import { useAuth, useIsGestor } from "@/contexts/AuthContext";
import { SecaoDobravel } from "@/components/aprendizado/SecaoDobravel";
import { IndicadorErrosLancamento } from "@/pages/Indicadores";
import { diaBrtAtras } from "@/lib/gestaoAgentes";
import {
  demandaPorOc, filtrarTratativas, mediaDoTime, resumoPorOperador, tempoPorCliente,
  type LinhaFilaAgora, type LinhaTratativa,
} from "@/lib/gestaoOperadores";

const PERIODOS = [
  { id: "7", rotulo: "7 dias", dias: 7 },
  { id: "30", rotulo: "30 dias", dias: 30 },
  { id: "90", rotulo: "90 dias", dias: 90 },
] as const;

function Kpi({ rotulo, valor, sub, ruim }: { rotulo: string; valor: string; sub?: string; ruim?: boolean }) {
  return (
    <div className="ticket-card px-5 py-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.13em] text-ink-mute">{rotulo}</div>
      <div className={`mt-1 text-[28px] font-bold leading-none tabular ${ruim ? "text-signal" : "text-ink-2"}`}>{valor}</div>
      {sub && <div className="mt-1 text-[12px] text-ink-soft-2">{sub}</div>}
    </div>
  );
}

export default function GestaoOperadores() {
  const { loading } = useAuth();
  const isGestor = useIsGestor();

  const [periodo, setPeriodo] = useState("30");
  const [operadorId, setOperadorIdRaw] = useState("");
  const [cliente, setCliente] = useState("");
  const [visaoOperadores, setVisaoOperadores] = useState<"grafico" | "lista">("grafico");
  const setOperadorId = (v: string) => {
    setOperadorIdRaw(v);
    setCliente(""); // cliente é dependente do operador (cascata)
  };

  const dias = PERIODOS.find((p) => p.id === periodo)?.dias ?? 30;
  const diaInicio = useMemo(() => diaBrtAtras(dias), [dias]);

  const tratativas = useQuery({
    queryKey: ["gestao-op-tratativas", diaInicio],
    queryFn: async () => {
      // FIX timeout (Caio 24/08, mig 349): o select paginado na view rodava a
      // view inteira A CADA página e estourava o statement_timeout de 8s do
      // authenticated (a lateral de oc_entrada varria card_events sem índice).
      // O RPC security-definer computa a janela UMA vez, sem custo de RLS por
      // linha, e devolve jsonb — sem teto de 1000 do PostgREST.
      const { data, error } = await supabase
        .rpc("gestao_operadores_tratativas", { p_dia_inicio: diaInicio });
      if (error) throw error;
      return (data ?? []) as LinhaTratativa[];
    },
    enabled: isGestor,
    staleTime: 60_000,
    retry: false,
  });

  const fila = useQuery({
    queryKey: ["gestao-op-fila"],
    queryFn: async () => {
      const { data, error } = await supabase.from("v_operador_fila_agora").select("*").limit(2000);
      if (error) throw error;
      return (data ?? []) as LinhaFilaAgora[];
    },
    enabled: isGestor,
    staleTime: 60_000,
    retry: false,
  });

  const marcadores = useQuery({
    queryKey: ["gestao-op-marcadores"],
    queryFn: async () => {
      const { data } = await supabase
        .from("marcadores_processo_operador")
        .select("id, agente_alvo, titulo_pergunta, validado_por, criado_em, resolvido_em")
        .is("resolvido_em", null)
        .order("criado_em", { ascending: false })
        .limit(50);
      return (data ?? []) as Array<{ id: string; agente_alvo: string | null; titulo_pergunta: string | null; validado_por: string | null; criado_em: string; resolvido_em: string | null }>;
    },
    enabled: isGestor,
    staleTime: 60_000,
    retry: false,
  });

  const operadores = useQuery({
    queryKey: ["gestao-op-operadores"],
    queryFn: async () => {
      const { data } = await supabase
        .from("operadores").select("id, nome").eq("cockpit_ativo", true).order("nome");
      return (data ?? []) as Array<{ id: string; nome: string }>;
    },
    enabled: isGestor,
    staleTime: 5 * 60_000,
  });

  const nomeDe = (id: string | null) =>
    (operadores.data ?? []).find((o) => o.id === id)?.nome ?? id?.slice(0, 8) ?? "—";

  const filtradas = useMemo(
    () => filtrarTratativas(tratativas.data ?? [], { operadorId: operadorId || null, cliente: cliente || null }),
    [tratativas.data, operadorId, cliente],
  );
  const filaFiltrada = useMemo(
    () => (fila.data ?? []).filter((f) => !operadorId || f.operador_id === operadorId),
    [fila.data, operadorId],
  );
  const resumo = useMemo(() => resumoPorOperador(filtradas, filaFiltrada), [filtradas, filaFiltrada]);
  const time = useMemo(() => mediaDoTime(tratativas.data ?? []), [tratativas.data]);
  const clientes = useMemo(() => tempoPorCliente(filtradas).slice(0, 12), [filtradas]);
  const demanda = useMemo(() => demandaPorOc(filtradas).slice(0, 10), [filtradas]);
  const demandaTotal = useMemo(() => filtradas.filter((t) => t.oc_entrada != null).length, [filtradas]);
  const paradas = useMemo(
    () => filaFiltrada.filter((f) => f.parado_mais_1d_util).sort((a, b) => b.horas_uteis - a.horas_uteis),
    [filaFiltrada],
  );
  // CASCATA (auditoria do Caio 21/08): com operador filtrado, só os clientes
  // DAQUELE operador aparecem; sem filtro, todos.
  const clientesOpcoes = useMemo(() => {
    const base = (tratativas.data ?? []).filter((t) => !operadorId || t.operador_id === operadorId);
    const m = new Map<string, string>();
    for (const t of base) {
      if (t.cnpj_pagador) m.set(t.cnpj_pagador, t.empresa_cliente ?? t.cnpj_pagador);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [tratativas.data, operadorId]);

  const dadosOperadores = useMemo(
    () => resumo.map((r) => ({
      nome: nomeDe(r.operadorId),
      ate2h: r.ate2hPct,
      tempo: r.horasUteisMedia,
      paradas: r.paradas1d,
      tratadas: r.tratadas,
    })).filter((d) => d.tratadas >= 3),
    [resumo, operadores.data],
  );
  // Insight: quem mais DISTANCIA da média do time (pra baixo) em ≤2h
  const maiorDistancia = useMemo(() => {
    if (time.ate2hPct == null) return null;
    let pior: { nome: string; delta: number; pct: number } | null = null;
    for (const d of dadosOperadores) {
      if (d.ate2h == null) continue;
      const delta = time.ate2hPct - d.ate2h;
      if (delta > 0 && (!pior || delta > pior.delta)) pior = { nome: d.nome, delta: Math.round(delta * 10) / 10, pct: d.ate2h };
    }
    return pior;
  }, [dadosOperadores, time.ate2hPct]);

  if (loading) return null;
  if (!isGestor) return <Navigate to="/inbox" replace />;

  // Banner HONESTO (lição 24/08: timeout de 8s aparecia como "mig não
  // aplicada" e enganou o diagnóstico). Cada causa fala o próprio nome.
  const erroFonte = (tratativas.error ?? fila.error) as
    | { code?: string; message?: string }
    | null;
  const erroBanner = !erroFonte
    ? null
    : erroFonte.code === "PGRST202" || /function .* does not exist|não existe a função/i.test(erroFonte.message ?? "")
      ? "A migration 349 (RPC gestao_operadores_tratativas) ainda não foi aplicada — os números aparecem depois da aplicação."
      : erroFonte.code === "42P01"
        ? "As views da Fase 1 (migration 344) ainda não foram aplicadas — os números aparecem depois da aplicação."
        : erroFonte.code === "57014"
          ? "A consulta excedeu o tempo limite do banco (timeout) — avise o Caio; os números não estão quebrados, só demoraram demais."
          : `Não consegui carregar os números: ${erroFonte.message ?? "erro desconhecido"}`;
  const totalTratadas = filtradas.length;
  const ate2h = filtradas.filter((t) => t.horas_uteis <= 2).length;

  return (
    <div className="mx-auto max-w-6xl px-6 pb-24 pt-8">
      <header className="mb-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-sal">Gestão · Operadores</div>
        <h1 className="mt-1 text-[26px] font-bold leading-tight text-ink-2">A operação, medida</h1>
        <p className="mt-1 text-[13px] text-ink-soft-2">
          Tempo em fila conta só <strong>horas úteis (08h–17h30)</strong> — card que chega à noite não penaliza ninguém.
        </p>
      </header>

      {erroBanner && (
        <div className="mb-6 rounded-lg border px-4 py-3 text-[13px]" style={{ borderColor: "var(--warning)", background: "var(--warning-soft)", color: "var(--warning)" }}>
          {erroBanner}
        </div>
      )}

      {/* Filtros */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-rule">
          {PERIODOS.map((p) => (
            <button key={p.id} onClick={() => setPeriodo(p.id)}
              className={`px-3 py-1.5 text-[12px] font-medium ${periodo === p.id ? "bg-ink text-white" : "bg-surface text-ink-soft-2 hover:bg-subtle"}`}>
              {p.rotulo}
            </button>
          ))}
        </div>
        <select value={operadorId} onChange={(e) => setOperadorId(e.target.value)}
          className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-[12px] text-ink-2">
          <option value="">Todos os operadores</option>
          {(operadores.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
        </select>
        <select value={cliente} onChange={(e) => setCliente(e.target.value)}
          className="max-w-[260px] rounded-lg border border-rule bg-surface px-3 py-1.5 text-[12px] text-ink-2">
          <option value="">Todos os clientes</option>
          {clientesOpcoes.map(([cnpj, nome]) => <option key={cnpj} value={cnpj}>{nome.slice(0, 34)}</option>)}
        </select>
      </div>

      {/* KPIs do período */}
      <SecaoDobravel id="gestao-op-kpis" titulo="Visão do período">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi rotulo="Cards tratados" valor={totalTratadas.toLocaleString("pt-BR")} sub="aprovações + rejeições humanas" />
          <Kpi rotulo="Tratados em ≤2h úteis" valor={totalTratadas > 0 ? `${Math.round((1000 * ate2h) / totalTratadas) / 10}%` : "—"} sub={`média do time: ${time.ate2hPct ?? "—"}%`} />
          <Kpi rotulo="Tempo médio na fila" valor={filtradas.length > 0 ? `${Math.round((filtradas.reduce((a, t) => a + t.horas_uteis, 0) / filtradas.length) * 10) / 10}h úteis` : "—"} sub={`média do time: ${time.horasUteisMedia ?? "—"}h`} />
          <Kpi rotulo="Parados >1 dia útil AGORA" valor={String(paradas.length)} sub="atacar hoje" ruim={paradas.length > 0} />
        </div>
      </SecaoDobravel>

      {/* Por operador — DASHBOARD comparativo (lista é opção) */}
      <SecaoDobravel id="gestao-op-por-operador" titulo="Comparativo por operador">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[12.5px] text-ink-soft-2">
            {maiorDistancia
              ? <>Quem mais distancia da média em tratar rápido: <strong className="text-signal">{maiorDistancia.nome}</strong> — {maiorDistancia.pct}% em ≤2h, <strong>{maiorDistancia.delta} pts abaixo</strong> da média do time ({time.ate2hPct}%).</>
              : "Todos na média ou acima em ≤2h úteis."}
          </p>
          <div className="flex overflow-hidden rounded-lg border border-rule">
            {(["grafico", "lista"] as const).map((v) => (
              <button key={v} onClick={() => setVisaoOperadores(v)}
                className={`px-3 py-1 text-[11px] font-medium ${visaoOperadores === v ? "bg-ink text-white" : "bg-surface text-ink-soft-2 hover:bg-subtle"}`}>
                {v === "grafico" ? "Gráficos" : "Ver lista"}
              </button>
            ))}
          </div>
        </div>

        {visaoOperadores === "grafico" && (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="ticket-card px-4 py-4">
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                % tratados em ≤2h úteis · linha = média do time ({time.ate2hPct ?? "—"}%)
              </p>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={dadosOperadores} margin={{ top: 16, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="nome" tick={{ fontSize: 10, fill: "var(--c-ink-soft)" }} interval={0} angle={-20} textAnchor="end" height={46} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }} />
                  <Tooltip formatter={(v: number) => [`${v}%`, "≤2h úteis"]} />
                  {time.ate2hPct != null && (
                    <ReferenceLine y={time.ate2hPct} stroke="var(--c-ink)" strokeDasharray="4 4"
                      label={{ value: `média ${time.ate2hPct}%`, fontSize: 10, fill: "var(--c-ink-soft)", position: "insideTopRight" }} />
                  )}
                  <Bar dataKey="ate2h" radius={[6, 6, 0, 0]}>
                    <LabelList dataKey="ate2h" position="top" formatter={(v: number | null) => (v != null ? `${v}%` : "")} style={{ fontSize: 10, fill: "var(--c-ink-soft)" }} />
                    {dadosOperadores.map((d, i) => (
                      <Cell key={i} fill={d.ate2h != null && time.ate2hPct != null && d.ate2h < time.ate2hPct ? "var(--signal)" : "var(--positive)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="ticket-card px-4 py-4">
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                Tempo médio na fila (h úteis) · linha = média do time ({time.horasUteisMedia ?? "—"}h) · menor é melhor
              </p>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={dadosOperadores} margin={{ top: 16, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="nome" tick={{ fontSize: 10, fill: "var(--c-ink-soft)" }} interval={0} angle={-20} textAnchor="end" height={46} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }} />
                  <Tooltip formatter={(v: number) => [`${v}h úteis`, "tempo médio"]} />
                  {time.horasUteisMedia != null && (
                    <ReferenceLine y={time.horasUteisMedia} stroke="var(--c-ink)" strokeDasharray="4 4"
                      label={{ value: `média ${time.horasUteisMedia}h`, fontSize: 10, fill: "var(--c-ink-soft)", position: "insideTopRight" }} />
                  )}
                  <Bar dataKey="tempo" radius={[6, 6, 0, 0]}>
                    <LabelList dataKey="tempo" position="top" formatter={(v: number | null) => (v != null ? `${v}h` : "")} style={{ fontSize: 10, fill: "var(--c-ink-soft)" }} />
                    {dadosOperadores.map((d, i) => (
                      <Cell key={i} fill={d.tempo != null && time.horasUteisMedia != null && d.tempo > time.horasUteisMedia ? "var(--signal)" : "var(--positive)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {visaoOperadores === "lista" && (
          <div className="ticket-card overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-rule font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                  <th className="px-4 py-2.5">Operador</th>
                  <th className="px-4 py-2.5 text-right">Tratados</th>
                  <th className="px-4 py-2.5 text-right">≤2h úteis</th>
                  <th className="px-4 py-2.5 text-right">Tempo médio</th>
                  <th className="px-4 py-2.5 text-right">Parados &gt;1d agora</th>
                </tr>
              </thead>
              <tbody>
                {resumo.map((r) => (
                  <tr key={r.operadorId} className="border-b border-rule last:border-0">
                    <td className="px-4 py-2.5 font-semibold text-ink-2">{nomeDe(r.operadorId)}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular">{r.tratadas}</td>
                    <td className={`px-4 py-2.5 text-right font-mono tabular ${r.ate2hPct != null && time.ate2hPct != null && r.ate2hPct < time.ate2hPct ? "text-signal" : "text-ink-2"}`}>
                      {r.ate2hPct != null ? `${r.ate2hPct}%` : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular">{r.horasUteisMedia != null ? `${r.horasUteisMedia}h` : "—"}</td>
                    <td className={`px-4 py-2.5 text-right font-mono tabular ${r.paradas1d > 0 ? "font-bold text-signal" : ""}`}>{r.paradas1d}</td>
                  </tr>
                ))}
                {resumo.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-ink-mute">Sem dados no período.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </SecaoDobravel>

      {/* Parados agora */}
      <SecaoDobravel id="gestao-op-parados" titulo={`Parados há mais de 1 dia útil — atacar (${paradas.length})`}>
        <div className="ticket-card overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-rule font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                <th className="px-4 py-2.5">NF</th>
                <th className="px-4 py-2.5">Cliente</th>
                <th className="px-4 py-2.5">Coluna</th>
                <th className="px-4 py-2.5">Operador</th>
                <th className="px-4 py-2.5 text-right">Parado há (úteis)</th>
              </tr>
            </thead>
            <tbody>
              {paradas.slice(0, 30).map((f) => (
                <tr key={f.card_id} className="border-b border-rule last:border-0">
                  <td className="px-4 py-2.5"><Link to={`/cards/${f.card_id}`} className="font-mono font-semibold text-sal underline-offset-2 hover:underline">{f.nf ?? "—"}</Link></td>
                  <td className="px-4 py-2.5 text-ink-soft-2">{(f.empresa_cliente ?? "—").slice(0, 30)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${f.coluna === "cliente_respondeu" ? "bg-subtle text-ink-soft-2" : "bg-signal-soft text-signal-strong"}`}>
                      {f.coluna === "cliente_respondeu" ? "cliente respondeu" : "aguardando você"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-ink-soft-2">{f.responsavel_relacionamento ?? nomeDe(f.operador_id)}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold tabular text-signal">{f.horas_uteis}h</td>
                </tr>
              ))}
              {paradas.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-ink-mute">Nada parado &gt;1 dia útil. 🎯</td></tr>}
            </tbody>
          </table>
        </div>
      </SecaoDobravel>

      {/* O que gera a demanda (Caio 21/08 v2): % dos tratados por oc geradora */}
      <SecaoDobravel id="gestao-op-demanda" titulo="O que gera a demanda — ocorrências que mais criam trabalho">
        {demanda.length > 0 ? (
          <>
            <p className="mb-3 text-[12.5px] text-ink-soft-2">
              Dos <strong className="text-ink-2">{demandaTotal.toLocaleString("pt-BR")}</strong> cards tratados
              {operadorId ? " deste operador" : ""} no período,{" "}
              <strong style={{ color: "var(--signal)" }}>{demanda[0]!.pct}% nasceram da oc {demanda[0]!.oc}</strong>
              {demanda[1] ? <> e {demanda[1].pct}% da oc {demanda[1].oc}</> : null} — é aí que a demanda nasce.
            </p>
            <div className="ticket-card px-4 py-4">
              <ResponsiveContainer width="100%" height={Math.max(180, Math.min(10, demanda.length) * 32)}>
                <BarChart data={demanda.map((d) => ({ nome: `oc ${d.oc}`, pct: d.pct, n: d.n }))} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }} unit="%" />
                  <YAxis type="category" dataKey="nome" width={64} tick={{ fontSize: 11, fill: "var(--c-ink)", fontFamily: "IBM Plex Mono" }} />
                  <Tooltip formatter={(v: number, _n, item) => [`${v}% · ${(item?.payload as { n?: number })?.n ?? "?"} cards`, "da demanda"]} />
                  <Bar dataKey="pct" radius={[0, 6, 6, 0]}>
                    <LabelList dataKey="pct" position="right" formatter={(v: number) => `${v}%`} style={{ fontSize: 11, fill: "var(--c-ink-soft)" }} />
                    {demanda.map((_, i) => (
                      <Cell key={i} fill={i === 0 ? "var(--signal)" : i === 1 ? "#F59F00" : "var(--c-ink-mute)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        ) : (
          <p className="py-4 text-center text-[13px] text-ink-mute">Sem dados de oc geradora no período/filtros.</p>
        )}
      </SecaoDobravel>

      {/* Tempo por cliente — gráfico (pior primeiro) + lista opcional */}
      <SecaoDobravel id="gestao-op-clientes" titulo="Tempo médio por cliente pagador" padraoAberto={false}>
        {clientes.length > 0 ? (
          <>
            <div className="ticket-card px-4 py-4">
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                Clientes que mais seguram a fila (h úteis até tratar) · linha = média do time ({time.horasUteisMedia ?? "—"}h)
              </p>
              <ResponsiveContainer width="100%" height={Math.max(180, Math.min(8, clientes.length) * 34)}>
                <BarChart data={clientes.slice(0, 8).map((c) => ({ nome: c.cliente.slice(0, 22), h: c.horasUteisMedia, casos: c.casos }))} layout="vertical" margin={{ top: 0, right: 44, bottom: 0, left: 8 }}>
                  <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }} />
                  <YAxis type="category" dataKey="nome" width={150} tick={{ fontSize: 11, fill: "var(--c-ink)" }} />
                  <Tooltip formatter={(v: number, _n, item) => [`${v}h úteis · ${(item?.payload as { casos?: number })?.casos ?? "?"} casos`, "tempo médio"]} />
                  {time.horasUteisMedia != null && <ReferenceLine x={time.horasUteisMedia} stroke="var(--c-ink)" strokeDasharray="4 4" />}
                  <Bar dataKey="h" radius={[0, 6, 6, 0]}>
                    <LabelList dataKey="h" position="right" formatter={(v: number) => `${v}h`} style={{ fontSize: 11, fill: "var(--c-ink-soft)" }} />
                    {clientes.slice(0, 8).map((c, i) => (
                      <Cell key={i} fill={time.horasUteisMedia != null && c.horasUteisMedia > time.horasUteisMedia ? "var(--signal)" : "var(--c-ink-mute)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <details className="group mt-2">
              <summary className="cursor-pointer list-none text-[12px] font-medium text-ink-soft-2 hover:text-ink-2">Ver lista completa ▾</summary>
              <div className="ticket-card mt-2 overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-rule font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                      <th className="px-4 py-2.5">Cliente</th>
                      <th className="px-4 py-2.5 text-right">Casos</th>
                      <th className="px-4 py-2.5 text-right">Tempo médio (úteis)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientes.map((c) => (
                      <tr key={c.cnpj ?? c.cliente} className="border-b border-rule last:border-0">
                        <td className="px-4 py-2.5 text-ink-2">{c.cliente.slice(0, 40)}</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular">{c.casos}</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular">{c.horasUteisMedia}h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        ) : (
          <p className="py-4 text-center text-[13px] text-ink-mute">Sem clientes com ≥3 casos no período/filtros.</p>
        )}
      </SecaoDobravel>

      {/* Marcadores de processo */}
      <SecaoDobravel id="gestao-op-marcadores" titulo={`Processo correto — operador errando (validado pela Isadora) · ${(marcadores.data ?? []).length}`}>
        <div className="space-y-2">
          {(marcadores.data ?? []).map((m) => (
            <div key={m.id} className="ticket-card px-4 py-3">
              <p className="text-[13px] font-medium text-ink-2">{m.titulo_pergunta ?? "Padrão validado"}</p>
              <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                {m.agente_alvo ?? ""} · validado por {m.validado_por ?? "gestão"} em {new Date(m.criado_em).toLocaleDateString("pt-BR")} · alinhar com o time
              </p>
            </div>
          ))}
          {(marcadores.data ?? []).length === 0 && (
            <p className="py-4 text-center text-[13px] text-ink-mute">
              Nenhum marcador aberto — quando a Isadora responder "o processo está correto — o operador está errando" no Aprendizado, aparece aqui.
            </p>
          )}
        </div>
      </SecaoDobravel>

      {/* Erros de lançamento por base (migrado da antiga aba Indicadores) */}
      <SecaoDobravel id="gestao-op-erros-base" titulo="Erros de lançamento por base (cobrança)" padraoAberto={false}>
        <IndicadorErrosLancamento />
      </SecaoDobravel>
    </div>
  );
}
