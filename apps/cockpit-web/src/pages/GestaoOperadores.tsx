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

import { supabase } from "@/lib/supabase";
import { useAuth, useIsGestor } from "@/contexts/AuthContext";
import { SecaoDobravel } from "@/components/aprendizado/SecaoDobravel";
import { IndicadorErrosLancamento } from "@/pages/Indicadores";
import { diaBrtAtras } from "@/lib/gestaoAgentes";
import {
  filtrarTratativas, mediaDoTime, resumoPorOperador, tempoPorCliente,
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
  const [operadorId, setOperadorId] = useState("");
  const [cliente, setCliente] = useState("");

  const dias = PERIODOS.find((p) => p.id === periodo)?.dias ?? 30;
  const diaInicio = useMemo(() => diaBrtAtras(dias), [dias]);

  const tratativas = useQuery({
    queryKey: ["gestao-op-tratativas", diaInicio],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_operador_tratativas").select("*").gt("dia", diaInicio).limit(20000);
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
  const paradas = useMemo(
    () => filaFiltrada.filter((f) => f.parado_mais_1d_util).sort((a, b) => b.horas_uteis - a.horas_uteis),
    [filaFiltrada],
  );
  const clientesOpcoes = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tratativas.data ?? []) {
      if (t.cnpj_pagador) m.set(t.cnpj_pagador, t.empresa_cliente ?? t.cnpj_pagador);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [tratativas.data]);

  if (loading) return null;
  if (!isGestor) return <Navigate to="/inbox" replace />;

  const migPendente = tratativas.isError || fila.isError;
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

      {migPendente && (
        <div className="mb-6 rounded-lg border px-4 py-3 text-[13px]" style={{ borderColor: "var(--warning)", background: "var(--warning-soft)", color: "var(--warning)" }}>
          As views da Fase 1 (migration 344) ainda não foram aplicadas — os números aparecem depois da aplicação.
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

      {/* Por operador */}
      <SecaoDobravel id="gestao-op-por-operador" titulo="Por operador">
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
        <p className="mt-2 text-[11px] text-ink-mute">Comparações em vermelho = abaixo da média do time ({time.ate2hPct ?? "—"}% ≤2h).</p>
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

      {/* Tempo por cliente */}
      <SecaoDobravel id="gestao-op-clientes" titulo="Tempo médio por cliente pagador" padraoAberto={false}>
        <div className="ticket-card overflow-x-auto">
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
              {clientes.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-ink-mute">Sem clientes com ≥3 casos no período.</td></tr>}
            </tbody>
          </table>
        </div>
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
