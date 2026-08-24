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
  diaBrtAtras, drillCorrigidas, drillSeguidas, fatiaProntaPraAutonomia,
  filtrarPlacar, porAgente, porFatia, seriePorDia, somarPlacar,
  type FatiaDrill, type LinhaDivergencia, type LinhaPlacarGestao,
} from "@/lib/gestaoAgentes";
import { paginarTudo } from "@/lib/supaPaginate";
import { toast } from "sonner";

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

function Kpi({ rotulo, valor, sub, destaque, onClick, ativo }: {
  rotulo: string; valor: string; sub?: string; destaque?: "ok" | "ruim";
  onClick?: () => void; ativo?: boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={`ticket-card px-5 py-4 text-left ${onClick ? "cursor-pointer transition-shadow hover:shadow-md-soft" : ""} ${ativo ? "!border-[1.5px]" : ""}`}
      style={ativo ? { borderColor: "var(--signal)" } : undefined}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.13em] text-ink-mute">{rotulo}</div>
      <div className={`mt-1 text-[28px] font-bold leading-none tabular ${destaque === "ok" ? "text-positive" : destaque === "ruim" ? "text-signal" : "text-ink-2"}`}>
        {valor}
      </div>
      {sub && <div className="mt-1 text-[12px] text-ink-soft-2">{sub}</div>}
      {onClick && (
        <div className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em]" style={{ color: "var(--signal)" }}>
          {ativo ? "▼ detalhando abaixo" : "clique pra detalhar ▸"}
        </div>
      )}
    </Tag>
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

// "VER CASOS" (Caio 24/08): todas as NFs que formam o número da linha do
// drill — pra estudar as divergências caso a caso com o time. Busca sob
// demanda na fonte única (agent_feedback, leitura de gestor), NF abre o card.
function CasosDaFatia({ agente, ocCard, ocSugerida, veredito, diaInicio, operadorId }: {
  agente: string;
  ocCard: number | null;
  ocSugerida: number | null;
  veredito: "seguida" | "corrigida";
  diaInicio: string;
  /** respeita o filtro de operador da página — a lista TEM que bater com o n da linha */
  operadorId: string | null;
}) {
  const casos = useQuery({
    queryKey: ["gestao-ag-casos", agente, ocCard, ocSugerida, veredito, diaInicio, operadorId],
    queryFn: async () => {
      let q = supabase
        .from("agent_feedback")
        .select("card_id, oc_executada, created_at, cards(nf)")
        .eq("agent_name", agente)
        .eq("veredito", veredito)
        .gte("created_at", `${diaInicio}T00:00:00-03:00`)
        .order("created_at", { ascending: false })
        .limit(1000);
      q = ocCard == null ? q.is("oc_card", null) : q.eq("oc_card", ocCard);
      q = ocSugerida == null ? q.is("oc_sugerida", null) : q.eq("oc_sugerida", ocSugerida);
      if (operadorId) q = q.eq("operador_id", operadorId);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as unknown as Array<{
        card_id: string; oc_executada: number | null; created_at: string;
        cards: { nf: string | null } | null;
      }>);
    },
    staleTime: 60_000,
    retry: false,
  });

  if (casos.isLoading) return <p className="px-3 py-2 text-[12px] text-ink-mute">carregando casos…</p>;
  if (casos.isError) return <p className="px-3 py-2 text-[12px] text-ink-mute">não consegui carregar os casos.</p>;
  const lista = casos.data ?? [];
  return (
    <div className="mt-1.5 rounded-[10px] border border-rule bg-surface px-3 py-2.5">
      <p className="mb-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-mute">
        {lista.length} caso{lista.length === 1 ? "" : "s"} — clique na NF pra abrir o card
      </p>
      <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
        {lista.map((c) => (
          <Link
            key={c.card_id}
            to={`/cards/${c.card_id}`}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-muted-2 px-2 py-1 font-mono text-[11px] text-ink-2 transition-colors hover:bg-signal-soft hover:text-signal"
            title={new Date(c.created_at).toLocaleDateString("pt-BR")}
          >
            NF {c.cards?.nf ?? "—"}
            {veredito === "corrigida" && c.oc_executada != null && (
              <span className="text-[10px] text-ink-mute">→ fez {c.oc_executada}</span>
            )}
          </Link>
        ))}
        {lista.length === 0 && <span className="text-[12px] text-ink-mute">nenhum caso na janela.</span>}
      </div>
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
  const [drill, setDrill] = useState<"corrigidas" | "seguidas" | null>("corrigidas");
  const [casosAbertos, setCasosAbertos] = useState<string | null>(null);
  const [agente, setAgente] = useState<string>("");
  const [operadorId, setOperadorId] = useState<string>("");

  const dias = PERIODOS.find((p) => p.id === periodo)?.dias ?? 30;
  const diaInicio = useMemo(() => diaBrtAtras(dias), [dias]);

  const placar = useQuery({
    queryKey: ["gestao-agentes-placar", diaInicio],
    queryFn: async () => {
      return await paginarTudo<LinhaPlacarGestao>(async (from, to) => {
        const { data, error } = await supabase
          .from("v_gestao_agentes_placar").select("*").gte("dia", diaInicio)
          .order("dia").range(from, to);
        if (error) throw error;
        return (data ?? []) as LinhaPlacarGestao[];
      });
    },
    enabled: isGestor,
    staleTime: 60_000,
    retry: false,
  });

  const diverg = useQuery({
    queryKey: ["gestao-agentes-diverg", diaInicio],
    queryFn: async () => {
      return await paginarTudo<LinhaDivergencia>(async (from, to) => {
        const { data, error } = await supabase
          .from("v_gestao_agentes_divergencias").select("*").gte("dia", diaInicio)
          .order("dia").range(from, to);
        if (error) throw error;
        return (data ?? []) as LinhaDivergencia[];
      });
    },
    enabled: isGestor,
    staleTime: 60_000,
    retry: false,
  });

  const acoes = useQuery({
    queryKey: ["gestao-agentes-acoes", diaInicio, operadorId],
    queryFn: async () => {
      return await paginarTudo(async (from, to) => {
        let q = supabase.from("v_acoes_cockpit").select("*").gte("dia", diaInicio)
          .order("dia").range(from, to);
        if (operadorId) q = q.eq("operador_id", operadorId);
        const { data, error } = await q;
        if (error) throw error;
        return (data ?? []) as Array<{ dia: string; tipo: string | null; operador_id: string | null; n: number }>;
      });
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

  const autonomas = useQuery({
    queryKey: ["gestao-agentes-autonomas"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fatias_autonomas")
        .select("agent_name, oc_card, oc_sugerida, ativa, demovida_em");
      return ((data ?? []) as Array<{ agent_name: string; oc_card: number | null; oc_sugerida: number; ativa: boolean; demovida_em: string | null }>)
        .filter((a) => a.demovida_em == null);
    },
    enabled: isGestor,
    staleTime: 60_000,
    retry: false,
  });
  const estadoFatia = (f: FatiaDrill): "ativa" | "sinalizada" | null => {
    const hit = (autonomas.data ?? []).find(
      (a) => a.agent_name === f.agent_name && a.oc_sugerida === f.oc_sugerida &&
        ((a.oc_card ?? null) === (f.oc_card ?? null) || a.oc_card == null),
    );
    return hit ? (hit.ativa ? "ativa" : "sinalizada") : null;
  };
  const [promovendo, setPromovendo] = useState<string | null>(null);
  const ligarAutonomo = async (f: FatiaDrill) => {
    const chave = `${f.agent_name}|${f.oc_card}|${f.oc_sugerida}`;
    if (!window.confirm(
      `SINALIZAR esta fatia pra autonomia:\n${agenteAmigavel(f.agent_name)} · card em oc ${f.oc_card ?? "—"} → sugere oc ${f.oc_sugerida}\n` +
      `(${f.pctSeguidas}% seguidas em ${f.pares} pares)\n\n` +
      `IMPORTANTE: isto NÃO liga nada. A fatia fica marcada como candidata e ` +
      `só passa a rodar sozinha após a validação EXPRESSA do Caio (regra 21/08).`,
    )) return;
    setPromovendo(chave);
    const { data, error } = await supabase.rpc("promover_fatia_autonoma", {
      p_agent_name: f.agent_name,
      p_oc_card: f.oc_card,
      p_oc_sugerida: f.oc_sugerida,
    });
    setPromovendo(null);
    if (error) {
      toast.error(`Não promovida: ${error.message}`);
      return;
    }
    const r = data as { ja_existia?: boolean } | null;
    toast.success(r?.ja_existia ? "Fatia já estava sinalizada." : "Fatia SINALIZADA ⚡ — aguarda a validação expressa do Caio pra ativar.");
    autonomas.refetch();
  };

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
  const fatiasCorrigidas = useMemo(() => drillCorrigidas(linhasFiltradas, divergFiltradas), [linhasFiltradas, divergFiltradas]);
  const fatiasSeguidas = useMemo(() => drillSeguidas(linhasFiltradas), [linhasFiltradas]);
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
            onClick={() => setDrill(drill === "seguidas" ? null : "seguidas")}
            ativo={drill === "seguidas"}
          />
          <Kpi rotulo="Corrigidas pelo operador" valor={String(totais.corrigidas)} sub="operador fez diferente" destaque={totais.corrigidas > 0 ? "ruim" : undefined}
            onClick={() => setDrill(drill === "corrigidas" ? null : "corrigidas")}
            ativo={drill === "corrigidas"}
          />
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

      {/* DRILL por fatia — substitui "Onde está a confusão" (Caio 21/08 v2):
          clique em Seguidas/Corrigidas abre a visão por AGENTE × OC GERADORA. */}
      {drill != null && (
        <SecaoDobravel
          id="gestao-ag-drill"
          titulo={drill === "corrigidas"
            ? "Onde atacar — corrigidas por agente × ocorrência geradora"
            : "Onde já acerta — seguidas por agente × ocorrência geradora"}
        >
          <p className="mb-3 text-[12.5px] text-ink-soft-2">
            {drill === "corrigidas"
              ? "Cada linha: a ocorrência do card que acionou o agente, o que ele sugeriu e o que o operador fez no lugar (a troca dominante). Pior fatia primeiro — é aí que a energia rende."
              : "Cada linha: a fatia que o operador segue. Fatia com ≥95% e ≥50 pares em 30d está pronta pra rodar sozinha — o botão ⚡ registra a autonomia."}
          </p>
          <div className="space-y-4">
            {[...new Set((drill === "corrigidas" ? fatiasCorrigidas : fatiasSeguidas).map((f) => f.agent_name))].map((agente) => {
              const fatias = (drill === "corrigidas" ? fatiasCorrigidas : fatiasSeguidas)
                .filter((f) => f.agent_name === agente)
                .slice(0, 12);
              return (
                <div key={agente} className="ticket-card px-4 py-3.5">
                  <div className="mb-2.5 flex items-center text-[13.5px] font-bold text-ink-2">
                    {agenteAmigavel(agente)}
                    <InfoAgente agente={agente} />
                  </div>
                  <div className="space-y-1.5">
                    {fatias.map((f) => {
                      const chave = `${f.agent_name}|${f.oc_card}|${f.oc_sugerida}`;
                      const estado = estadoFatia(f);
                      const pronta = fatiaProntaPraAutonomia(f) && estado == null;
                      return (
                        <div key={chave}>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] px-3 py-2"
                          style={{ background: "var(--bg-subtle)" }}>
                          <span className="font-mono text-[12px] text-ink-soft-2">
                            card em <strong className="text-ink-2">oc {f.oc_card ?? "—"}</strong>
                          </span>
                          <span className="text-ink-mute">→</span>
                          <span className="font-mono text-[12px] text-ink-soft-2">
                            sugeriu <strong className="text-ink-2">oc {f.oc_sugerida ?? "—"}</strong>
                          </span>
                          <span className="text-ink-mute">→</span>
                          {drill === "corrigidas" ? (
                            <span className="font-mono text-[12px]">
                              operador fez <strong style={{ color: "var(--signal)" }}>oc {f.oc_executada ?? "—"}</strong>
                              <span className="text-ink-mute"> · {f.n}×</span>
                            </span>
                          ) : (
                            <span className="font-mono text-[12px] text-positive">
                              operador seguiu · {f.n}×
                            </span>
                          )}
                          <span className="ml-auto flex items-center gap-2">
                            {/* Fix 21/08: cada drill mostra o % da PRÓPRIA
                                dimensão, ROTULADO — na visão corrigidas o
                                92,7% de seguidas parecia taxa de correção. */}
                            {drill === "corrigidas" ? (
                              <span className="font-mono text-[12px] font-bold tabular" style={{ color: "var(--signal)" }}>
                                {f.pctCorrigidas != null ? `${f.pctCorrigidas}%` : "—"}
                                <span className="font-normal text-ink-mute"> corrigidas · de {f.pares}</span>
                              </span>
                            ) : (
                              <span className="font-mono text-[12px] font-bold tabular"
                                style={{ color: (f.pctSeguidas ?? 0) >= META_PCT ? "var(--positive)" : "var(--c-ink-soft)" }}>
                                {f.pctSeguidas != null ? `${f.pctSeguidas}%` : "—"}
                                <span className="font-normal text-ink-mute"> seguidas · de {f.pares}</span>
                              </span>
                            )}
                            {estado === "ativa" && (
                              <span className="rounded-[20px] px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em]"
                                style={{ background: "var(--positive-soft)", color: "var(--positive)" }}>
                                ⚡ autônoma
                              </span>
                            )}
                            {estado === "sinalizada" && (
                              <span className="rounded-[20px] px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em]"
                                style={{ background: "var(--warning-soft)", color: "var(--warning)" }}
                                title="Candidata registrada — só roda sozinha após validação expressa do Caio">
                                ⚡ sinalizada · aguarda Caio
                              </span>
                            )}
                            {pronta && (
                              <button
                                onClick={() => ligarAutonomo(f)}
                                disabled={promovendo === chave}
                                className="rounded-[20px] px-2.5 py-1 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-white transition-opacity hover:opacity-85 disabled:opacity-40"
                                style={{ background: "var(--positive)" }}
                              >
                                {promovendo === chave ? "sinalizando…" : "⚡ sinalizar autonomia"}
                              </button>
                            )}
                            <button
                              onClick={() => setCasosAbertos(casosAbertos === chave ? null : chave)}
                              className="font-mono text-[10.5px] font-semibold text-sal underline-offset-2 hover:underline"
                            >
                              {casosAbertos === chave ? "fechar casos ▴" : "ver casos ▾"}
                            </button>
                          </span>
                        </div>
                        {casosAbertos === chave && (
                          <CasosDaFatia
                            agente={f.agent_name}
                            ocCard={f.oc_card}
                            ocSugerida={f.oc_sugerida}
                            veredito={drill === "corrigidas" ? "corrigida" : "seguida"}
                            diaInicio={diaInicio}
                            operadorId={operadorId || null}
                          />
                        )}
                        </div>
                      );
                    })}
                    {fatias.length === 0 && (
                      <p className="py-2 text-center text-[12px] text-ink-mute">nada nesta visão com os filtros atuais</p>
                    )}
                  </div>
                </div>
              );
            })}
            {(drill === "corrigidas" ? fatiasCorrigidas : fatiasSeguidas).length === 0 && (
              <p className="py-6 text-center text-[13px] text-ink-mute">Sem dados no período/filtros.</p>
            )}
          </div>
        </SecaoDobravel>
      )}

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
