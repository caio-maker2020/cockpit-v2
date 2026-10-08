// =============================================================================
// GESTÃO AGENTES — TORRE (Matheus 08/10, reconstrução). Um norte: 95% das
// sugestões seguidas exatamente pelo operador. A tela segue o FLUXO do loop:
//
//   1. agentes sugerem → 2. operador decide (placar, ranking, evolução)
//   → 3. onde perde pontos (trocas que mais custam pts + caminho até a meta)
//   → 4. ciclo de treino (learning_log: padrão → pergunta → sugestão →
//        aprovação → no ar) → 5. impacto medido (antes × depois do merge)
//   → 6. autonomia por fatia (candidatas + ativas).
//
// Só gestores. Fontes (sem nada novo no banco): v_gestao_agentes_placar /
// _divergencias (mig 344/347), v_melhorias_impacto, learning_log (197/299),
// fatias_autonomas (340) + RPC promover_fatia_autonoma (347), agent_feedback.
// Sem a migration aplicada, cada bloco avisa e não quebra.
// =============================================================================
import { useMemo, useState } from "react";
import { Navigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import { useAuth, useIsGestor } from "@/contexts/AuthContext";
import { agenteAmigavel } from "@/lib/agentesCatalogo";
import { TorreAgentes, type EventoTorre } from "@/components/gestao/TorreAgentes";
import { CasosDaFatia } from "@/components/gestao/CasosDaFatia";
import {
  contarCiclo, diaBrtAtras, drillSeguidas, etapaDoItem, fatiaProntaPraAutonomia, filtrarPlacar,
  pontosPorTroca, rankingAgentes, separarManterAguardar, seriePorSemana, somarPlacar, trocasAteAMeta,
  type EtapaCiclo, type FatiaDrill, type ItemLearningLog, type LinhaDivergencia, type LinhaPlacarGestao,
  type TrocaComPontos,
} from "@/lib/gestaoAgentes";
import { paginarTudo } from "@/lib/supaPaginate";

const META_PCT = 95;
const MIN_PARES_RANKING = 10;

const PERIODOS = [
  { id: "7", rotulo: "7 dias", dias: 7 },
  { id: "30", rotulo: "30 dias", dias: 30 },
  { id: "90", rotulo: "90 dias", dias: 90 },
] as const;

// ---------- pedacinhos de UI (design system do Cockpit) ----------

function Rotulo({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[10px] uppercase tracking-[0.13em] text-ink-mute">{children}</div>;
}

/** Cabeçalho de etapa do fluxo: número + título + 1 frase do porquê. */
function Etapa({ n, titulo, sub, children }: { n: number; titulo: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold text-white"
          style={{ background: "var(--signal)" }}>{n}</span>
        <div>
          <h2 className="text-[17px] font-bold leading-tight text-ink-2">{titulo}</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-soft-2">{sub}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Aviso({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border px-4 py-3 text-[12.5px]"
      style={{ borderColor: "var(--warning)", background: "var(--warning-soft)", color: "var(--warning)" }}>
      {children}
    </div>
  );
}

const ETAPAS_CICLO: Array<{ id: EtapaCiclo; rotulo: string; quem: string; dica: string }> = [
  { id: "padrao", rotulo: "Padrão achado", quem: "agente-aprendizado (diário)", dica: "agrupa as correções novas e acha o padrão" },
  { id: "pergunta", rotulo: "Pergunta ao gestor", quem: "gestor responde", dica: "quando o padrão é ambíguo, pergunta antes de propor" },
  { id: "sugerida", rotulo: "Ajuste sugerido", quem: "aguardando decisão", dica: "regra pronta pra virar prompt — passa por replay" },
  { id: "aprovada", rotulo: "Aprovada", quem: "vira PR ai-melhoria/*", dica: "a action insere a regra no bloco APRENDIZADOS-GESTAO" },
  { id: "no_ar", rotulo: "No ar", quem: "merge do Caio + deploy", dica: "a partir daqui o antes × depois é medido" },
];

// ---------- página ----------

export default function GestaoAgentes() {
  const { loading } = useAuth();
  const isGestor = useIsGestor();

  const [periodo, setPeriodo] = useState<string>("30");
  const [agente, setAgente] = useState<string>("");
  const [operadorId, setOperadorId] = useState<string>("");
  const [agenteFoco, setAgenteFoco] = useState<string>("");
  const [casosAbertos, setCasosAbertos] = useState<string | null>(null);
  const [verTodasTrocas, setVerTodasTrocas] = useState(false);

  const dias = PERIODOS.find((p) => p.id === periodo)?.dias ?? 30;
  const diaInicio = useMemo(() => diaBrtAtras(dias), [dias]);

  const placar = useQuery({
    queryKey: ["gestao-agentes-placar", diaInicio],
    queryFn: () => paginarTudo<LinhaPlacarGestao>(async (from, to) => {
      const { data, error } = await supabase.from("v_gestao_agentes_placar").select("*")
        .gte("dia", diaInicio).order("dia").range(from, to);
      if (error) throw error;
      return (data ?? []) as LinhaPlacarGestao[];
    }),
    enabled: isGestor, staleTime: 60_000, retry: false,
  });

  const diverg = useQuery({
    queryKey: ["gestao-agentes-diverg", diaInicio],
    queryFn: () => paginarTudo<LinhaDivergencia>(async (from, to) => {
      const { data, error } = await supabase.from("v_gestao_agentes_divergencias").select("*")
        .gte("dia", diaInicio).order("dia").range(from, to);
      if (error) throw error;
      return (data ?? []) as LinhaDivergencia[];
    }),
    enabled: isGestor, staleTime: 60_000, retry: false,
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
    enabled: isGestor, staleTime: 60_000, retry: false,
  });

  // ciclo de treino — o caderno do agente-aprendizado (mesma fonte do /aprendizado)
  const ciclo = useQuery({
    queryKey: ["gestao-agentes-ciclo", diaInicio],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("learning_log")
        .select("id, tipo, status, agente_alvo, titulo, resumo, created_at, detalhes")
        .in("tipo", ["padrao_identificado", "pergunta", "ajuste_sugerido", "ajuste_aprovado", "ajuste_rejeitado", "ajuste_aplicado"])
        .gte("created_at", `${diaInicio}T00:00:00-03:00`)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as ItemLearningLog[];
    },
    enabled: isGestor, staleTime: 60_000, retry: false,
  });

  const autonomas = useQuery({
    queryKey: ["gestao-agentes-autonomas"],
    queryFn: async () => {
      const { data } = await supabase.from("fatias_autonomas")
        .select("agent_name, oc_card, oc_sugerida, ativa, demovida_em");
      return ((data ?? []) as Array<{ agent_name: string; oc_card: number | null; oc_sugerida: number; ativa: boolean; demovida_em: string | null }>)
        .filter((a) => a.demovida_em == null);
    },
    enabled: isGestor, staleTime: 60_000, retry: false,
  });

  const operadores = useQuery({
    queryKey: ["gestao-agentes-operadores"],
    queryFn: async () => {
      const { data } = await supabase.from("operadores").select("id, nome").eq("cockpit_ativo", true).order("nome");
      return (data ?? []) as Array<{ id: string; nome: string }>;
    },
    enabled: isGestor, staleTime: 5 * 60_000,
  });

  // ---------- derivados (tudo puro, em lib/gestaoAgentes.ts) ----------
  const filtro = useMemo(() => ({ agente: agente || null, operadorId: operadorId || null }), [agente, operadorId]);
  const splitPlacar = useMemo(() => separarManterAguardar(filtrarPlacar(placar.data ?? [], filtro)), [placar.data, filtro]);
  const splitDiverg = useMemo(
    () => separarManterAguardar(filtrarPlacar(diverg.data ?? [], filtro) as LinhaDivergencia[]),
    [diverg.data, filtro],
  );
  const linhas = splitPlacar.principais;
  const totais = useMemo(() => somarPlacar(linhas), [linhas]);
  const totaisManter = useMemo(() => somarPlacar(splitPlacar.manter), [splitPlacar.manter]);
  const semanas = useMemo(() => seriePorSemana(linhas), [linhas]);
  const ranking = useMemo(() => rankingAgentes(linhas, MIN_PARES_RANKING, META_PCT), [linhas]);
  const trocas = useMemo(() => pontosPorTroca(linhas, splitDiverg.principais), [linhas, splitDiverg.principais]);
  const fatiasSeguidas = useMemo(() => drillSeguidas(linhas), [linhas]);
  const ateMeta = useMemo(() => trocasAteAMeta(trocas, totais.pctAcerto, META_PCT), [trocas, totais.pctAcerto]);
  const contagemCiclo = useMemo(() => contarCiclo(ciclo.data ?? []), [ciclo.data]);
  const filaDecisao = useMemo(
    () => (ciclo.data ?? []).filter((i) => {
      const e = etapaDoItem(i);
      return (e === "sugerida" || e === "pergunta") && i.status === "aberto" && (!agente || i.agente_alvo === agente);
    }),
    [ciclo.data, agente],
  );

  const estadoFatia = (f: { agent_name: string; oc_card: number | null; oc_sugerida: number | null }): "ativa" | "sinalizada" | null => {
    const hit = (autonomas.data ?? []).find(
      (a) => a.agent_name === f.agent_name && a.oc_sugerida === f.oc_sugerida &&
        ((a.oc_card ?? null) === (f.oc_card ?? null) || a.oc_card == null),
    );
    return hit ? (hit.ativa ? "ativa" : "sinalizada") : null;
  };
  const candidatas = fatiasSeguidas.filter((f) => fatiaProntaPraAutonomia(f) && estadoFatia(f) == null);
  const quaseProntas = fatiasSeguidas
    .filter((f) => !fatiaProntaPraAutonomia(f) && f.oc_sugerida != null && (f.pctSeguidas ?? 0) >= 85 && f.pares >= 20 && estadoFatia(f) == null)
    .slice(0, 6);

  /** O que a melhoria FEZ: pts ganhos e se a amostra pós já é suficiente. */
  const impactos = useMemo(() => (melhorias.data ?? [])
    .map((m) => ({ ...m, delta: m.pct_pre != null && m.pct_pos != null ? Math.round((m.pct_pos - m.pct_pre) * 10) / 10 : null }))
    .sort((a, b) => b.mergeado_em.localeCompare(a.mergeado_em)), [melhorias.data]);
  const ptsGanhosMelhorias = impactos.reduce((s, m) => s + (m.delta != null && m.pares_pos >= 20 ? m.delta : 0), 0);

  const eventosTorre = useMemo<EventoTorre[]>(() => {
    const ev: Array<EventoTorre & { ts: string }> = [];
    for (const m of impactos) {
      if (m.mergeado_em.slice(0, 10) < diaInicio) continue;
      ev.push({
        ts: m.mergeado_em,
        quando: new Date(m.mergeado_em).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
        quem: agenteAmigavel(m.agente_alvo ?? ""),
        texto: `no ar: ${m.titulo ?? "melhoria"} · ${m.pct_pre ?? "—"}% → ${m.pct_pos ?? "—"}%`,
        tom: m.delta == null ? "neutro" : m.delta >= 0 ? "ok" : "ruim",
      });
    }
    for (const i of ciclo.data ?? []) {
      const e = etapaDoItem(i);
      if (e !== "sugerida" && e !== "aprovada") continue;
      ev.push({
        ts: i.created_at,
        quando: new Date(i.created_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
        quem: agenteAmigavel(i.agente_alvo ?? "agente-aprendizado"),
        texto: `${e === "aprovada" ? "aprovada" : "sugerida"}: ${i.titulo ?? i.resumo ?? "ajuste"}`,
        tom: "neutro",
      });
    }
    return ev.sort((a, b) => b.ts.localeCompare(a.ts));
  }, [impactos, ciclo.data, diaInicio]);

  const [promovendo, setPromovendo] = useState<string | null>(null);
  const sinalizarAutonomia = async (f: FatiaDrill) => {
    const chave = `${f.agent_name}|${f.oc_card}|${f.oc_sugerida}`;
    if (!window.confirm(
      `SINALIZAR esta fatia pra autonomia:\n${agenteAmigavel(f.agent_name)} · card em oc ${f.oc_card ?? "—"} → sugere oc ${f.oc_sugerida}\n` +
      `(${f.pctSeguidas}% seguidas em ${f.pares} pares)\n\n` +
      `IMPORTANTE: isto NÃO liga nada. A fatia fica marcada como candidata e ` +
      `só passa a rodar sozinha após a validação EXPRESSA do Caio (regra 21/08).`,
    )) return;
    setPromovendo(chave);
    const { data, error } = await supabase.rpc("promover_fatia_autonoma", {
      p_agent_name: f.agent_name, p_oc_card: f.oc_card, p_oc_sugerida: f.oc_sugerida,
    });
    setPromovendo(null);
    if (error) { toast.error(`Não promovida: ${error.message}`); return; }
    const r = data as { ja_existia?: boolean } | null;
    toast.success(r?.ja_existia ? "Fatia já estava sinalizada." : "Fatia SINALIZADA ⚡ — aguarda a validação expressa do Caio pra ativar.");
    autonomas.refetch();
  };

  if (loading) return null;
  if (!isGestor) return <Navigate to="/inbox" replace />;

  const migPendente = placar.isError || diverg.isError;
  const trocasVisiveis = verTodasTrocas ? trocas.slice(0, 40) : trocas.slice(0, 8);
  const maxPts = Math.max(0.1, ...trocas.map((t) => t.ptsGlobal));
  const gap = totais.pctAcerto != null ? Math.max(0, Math.round((META_PCT - totais.pctAcerto) * 10) / 10) : null;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-8 md:px-6">
      <header className="mb-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-sal">Gestão · Torre de agentes</div>
        <h1 className="mt-1 text-[26px] font-bold leading-tight text-ink-2">
          Quem acerta, onde perde pontos e como cada agente está sendo treinado
        </h1>
        <p className="mt-1 text-[13px] text-ink-soft-2">
          Meta: <strong>{META_PCT}%</strong> das sugestões seguidas exatamente pelo operador.
          {gap != null && gap > 0 && <> Faltam <strong style={{ color: "var(--signal)" }}>{gap} pts</strong> no período.</>}
          {gap === 0 && <> <strong style={{ color: "var(--positive)" }}>Meta batida no período.</strong></>}
        </p>
      </header>

      {migPendente && <div className="mb-6"><Aviso>As views da migration 344/347 ainda não estão aplicadas em produção — os números aparecem depois da aplicação.</Aviso></div>}

      {/* filtros */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-rule">
          {PERIODOS.map((p) => (
            <button key={p.id} onClick={() => setPeriodo(p.id)}
              className={`px-3 py-1.5 text-[12px] font-medium ${periodo === p.id ? "bg-ink text-white" : "bg-surface text-ink-soft-2 hover:bg-subtle"}`}>
              {p.rotulo}
            </button>
          ))}
        </div>
        <select value={agente} onChange={(e) => setAgente(e.target.value)}
          className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-[12px] text-ink-2">
          <option value="">Todos os agentes</option>
          {[...new Set((placar.data ?? []).map((l) => l.agent_name))].sort().map((a) => (
            <option key={a} value={a}>{agenteAmigavel(a)}</option>
          ))}
        </select>
        <select value={operadorId} onChange={(e) => setOperadorId(e.target.value)}
          className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-[12px] text-ink-2">
          <option value="">Todos os operadores</option>
          {(operadores.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
        </select>
      </div>

      {/* 1+2 — agentes sugerem, operador decide */}
      <Etapa n={1} titulo="Agentes sugerem, operador decide"
        sub="Acerto = o operador fez exatamente a oc sugerida. Ranking, evolução semanal e a ficha de cada agente.">
        <TorreAgentes
          ranking={ranking}
          semanas={semanas}
          totais={totais}
          totaisManter={totaisManter}
          meta={META_PCT}
          minPares={MIN_PARES_RANKING}
          selecionado={agenteFoco}
          onSelecionar={setAgenteFoco}
          autonomas={autonomas.data ?? []}
          piorTrocaDe={(a) => {
            const t = trocas.find((x) => x.agent_name === a);
            return t ? { ...t, pares: 0, pctSeguidas: null, pctCorrigidas: null } : undefined;
          }}
          melhorFatiaDe={(a) => fatiasSeguidas.find((f) => f.agent_name === a && f.pares >= 5)}
          eventos={eventosTorre}
        />
      </Etapa>

      {/* 3 — onde perde pontos */}
      <Etapa n={2} titulo="Onde os pontos estão sendo perdidos"
        sub="Cada linha é uma troca exata: card na oc X, agente sugeriu Y, operador fez Z. 'pts' = quanto o acerto subiria se essa troca virasse acerto.">
        <div className="mb-3 grid gap-3 md:grid-cols-3">
          <div className="ticket-card px-5 py-4">
            <Rotulo>Gap até a meta</Rotulo>
            <div className="mt-1 text-[28px] font-bold leading-none tabular" style={{ color: gap ? "var(--signal)" : "var(--positive)" }}>
              {gap != null ? `${gap} pts` : "—"}
            </div>
            <div className="mt-1 text-[12px] text-ink-soft-2">{totais.pctAcerto ?? "—"}% hoje → {META_PCT}%</div>
          </div>
          <div className="ticket-card px-5 py-4">
            <Rotulo>Trocas pra fechar o gap</Rotulo>
            <div className="mt-1 text-[28px] font-bold leading-none tabular text-ink-2">
              {ateMeta == null ? (gap ? "—" : "0") : ateMeta}
            </div>
            <div className="mt-1 text-[12px] text-ink-soft-2">
              {ateMeta == null && gap
                ? "nem resolvendo todas as trocas — parte do gap é abstenção/volume"
                : "resolvendo as maiores trocas, em ordem"}
            </div>
          </div>
          <div className="ticket-card px-5 py-4">
            <Rotulo>Top 3 trocas valem</Rotulo>
            <div className="mt-1 text-[28px] font-bold leading-none tabular" style={{ color: "var(--positive)" }}>
              +{Math.round(trocas.slice(0, 3).reduce((s, t) => s + t.ptsGlobal, 0) * 10) / 10} pts
            </div>
            <div className="mt-1 text-[12px] text-ink-soft-2">no acerto global, se viram regra</div>
          </div>
        </div>

        <div className="ticket-card px-4 py-4">
          <div className="space-y-1.5">
            {trocasVisiveis.map((t, i) => {
              const chave = `t|${t.agent_name}|${t.oc_card}|${t.oc_sugerida}|${t.oc_executada}`;
              return (
                <div key={chave}>
                  <div className="rounded-[10px] bg-subtle px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="w-6 font-mono text-[11px] font-bold text-ink-mute">{i + 1}</span>
                      <span className="text-[12.5px] font-bold text-ink-2">{agenteAmigavel(t.agent_name)}</span>
                      <span className="font-mono text-[12px] text-ink-soft-2">
                        card em <strong className="text-ink-2">oc {t.oc_card ?? "—"}</strong> → sugeriu <strong className="text-ink-2">oc {t.oc_sugerida ?? "—"}</strong> → operador fez{" "}
                        <strong style={{ color: "var(--signal)" }}>oc {t.oc_executada}</strong> · {t.n}×
                      </span>
                      <span className="ml-auto flex items-center gap-3">
                        <span className="w-28">
                          <span className="block h-1.5 overflow-hidden rounded-full bg-surface">
                            <span className="block h-full rounded-full" style={{ width: `${(100 * t.ptsGlobal) / maxPts}%`, background: "var(--signal)" }} />
                          </span>
                        </span>
                        <span className="w-20 text-right font-mono text-[12.5px] font-bold tabular" style={{ color: "var(--signal)" }}>−{t.ptsGlobal} pts</span>
                        <button onClick={() => setCasosAbertos(casosAbertos === chave ? null : chave)}
                          className="font-mono text-[10.5px] font-semibold text-sal underline-offset-2 hover:underline">
                          {casosAbertos === chave ? "fechar ▴" : "ver casos ▾"}
                        </button>
                      </span>
                    </div>
                    <div className="mt-1 pl-9 text-[11.5px] text-ink-soft-2">
                      <SugestaoTreino t={t} />
                    </div>
                  </div>
                  {casosAbertos === chave && (
                    <CasosDaFatia agente={t.agent_name} ocCard={t.oc_card} ocSugerida={t.oc_sugerida}
                      ocExecutada={t.oc_executada} veredito="corrigida" diaInicio={diaInicio} operadorId={operadorId || null} />
                  )}
                </div>
              );
            })}
            {trocas.length === 0 && <p className="py-4 text-center text-[13px] text-ink-mute">Nenhuma correção no período/filtros.</p>}
          </div>
          {trocas.length > 8 && (
            <button onClick={() => setVerTodasTrocas(!verTodasTrocas)}
              className="mt-3 font-mono text-[11px] font-semibold text-sal hover:underline">
              {verTodasTrocas ? "mostrar só as 8 maiores ▴" : `ver todas as ${Math.min(40, trocas.length)} trocas ▾`}
            </button>
          )}
          <p className="mt-3 border-t border-rule pt-2 text-[11px] text-ink-mute">
            Como ler: "−3,2 pts" = se essa troca tivesse sido acerto, o acerto global estaria 3,2 pts mais alto.
            O texto abaixo de cada troca é a sugestão de treino calculada pela torre a partir dos números — confira os casos antes de virar regra.
          </p>
        </div>
      </Etapa>

      {/* 4 — ciclo de treino */}
      <Etapa n={3} titulo="Ciclo de treino — como uma correção vira regra"
        sub="O agente-aprendizado lê as correções todo dia e propõe ajustes. Nada muda no agente sem decisão humana, replay e merge.">
        {ciclo.isError ? (
          <Aviso>Não consegui ler o caderno de aprendizado (learning_log).</Aviso>
        ) : (
          <>
            <div className="grid gap-2 md:grid-cols-5">
              {ETAPAS_CICLO.map((e, i) => (
                <div key={e.id} className="ticket-card relative px-4 py-3.5">
                  <Rotulo>{i + 1} · {e.rotulo}</Rotulo>
                  <div className="mt-1 text-[26px] font-bold leading-none tabular"
                    style={{ color: e.id === "sugerida" || e.id === "pergunta" ? (contagemCiclo[e.id] ? "var(--warning)" : undefined) : e.id === "no_ar" ? "var(--positive)" : undefined }}>
                    {contagemCiclo[e.id]}
                  </div>
                  <div className="mt-1 text-[11px] font-semibold text-ink-2">{e.quem}</div>
                  <div className="mt-0.5 text-[11px] text-ink-soft-2">{e.dica}</div>
                  {i < ETAPAS_CICLO.length - 1 && (
                    <span className="absolute -right-2 top-1/2 z-10 hidden -translate-y-1/2 text-ink-mute md:block">→</span>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-ink-mute">
              Contagem no período · {contagemCiclo.recusada} recusada(s)/revertida(s) — recusa também ensina: o motivo volta pro agente-aprendizado.
            </p>

            <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_340px]">
              <div className="ticket-card px-4 py-4">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <div className="text-[14px] font-bold text-ink-2">Esperando decisão do gestor</div>
                  <Link to="/aprendizado" className="font-mono text-[11px] font-semibold text-sal hover:underline">decidir no Aprendizado ▸</Link>
                </div>
                <div className="space-y-2">
                  {filaDecisao.slice(0, 8).map((i) => (
                    <div key={i.id} className="rounded-[10px] bg-subtle px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-[20px] px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em]"
                          style={{ background: "var(--warning-soft)", color: "var(--warning)" }}>
                          {i.tipo === "pergunta" ? "pergunta" : "ajuste"}
                        </span>
                        <span className="text-[12.5px] font-semibold text-ink-2">{i.titulo ?? "(sem título)"}</span>
                        <span className="ml-auto font-mono text-[10px] text-ink-mute">
                          {agenteAmigavel(i.agente_alvo ?? "")} · {new Date(i.created_at).toLocaleDateString("pt-BR")}
                        </span>
                      </div>
                      {i.resumo && <p className="mt-1 line-clamp-2 text-[11.5px] text-ink-soft-2">{i.resumo}</p>}
                    </div>
                  ))}
                  {filaDecisao.length === 0 && !ciclo.isLoading && (
                    <p className="py-3 text-center text-[12.5px] text-ink-mute">Nada esperando decisão no período.</p>
                  )}
                </div>
              </div>

              <div className="ticket-card px-4 py-4">
                <Rotulo>Como rodar um ciclo de treino</Rotulo>
                <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[12px] text-ink-soft-2">
                  <li><strong className="text-ink-2">Escolha a troca</strong> com mais pts na etapa 2 — uma por vez.</li>
                  <li><strong className="text-ink-2">Leia 10 casos</strong> ("ver casos"): o operador está certo sempre, ou depende de algo (cliente, prazo, conteúdo do e-mail)?</li>
                  <li><strong className="text-ink-2">Escreva a regra</strong> no Aprendizado (responda a pergunta ou aprove o ajuste) com o caso-âncora.</li>
                  <li><strong className="text-ink-2">Replay</strong> nos casos antigos antes do merge (<code className="font-mono text-[11px]">evals/replay-regras.ts</code>) — a regra não pode quebrar o que já acerta.</li>
                  <li><strong className="text-ink-2">Merge + deploy</strong>: a regra entra no bloco APRENDIZADOS-GESTAO do prompt.</li>
                  <li><strong className="text-ink-2">Meça em 7–14 dias</strong> na etapa 4 — só conta com ≥20 pares depois do merge.</li>
                </ol>
              </div>
            </div>
          </>
        )}
      </Etapa>

      {/* 5 — impacto */}
      <Etapa n={4} titulo="Impacto — o treino funcionou?"
        sub="Cada melhoria no ar: acerto da fatia nos 30 dias antes do merge × depois do merge.">
        <div className="mb-3 grid gap-3 md:grid-cols-3">
          <div className="ticket-card px-5 py-4">
            <Rotulo>Melhorias no ar</Rotulo>
            <div className="mt-1 text-[28px] font-bold leading-none tabular text-ink-2">{impactos.length}</div>
          </div>
          <div className="ticket-card px-5 py-4">
            <Rotulo>Subiram / caíram</Rotulo>
            <div className="mt-1 text-[28px] font-bold leading-none tabular">
              <span style={{ color: "var(--positive)" }}>{impactos.filter((m) => (m.delta ?? 0) > 0).length}</span>
              <span className="text-ink-mute"> / </span>
              <span style={{ color: "var(--signal)" }}>{impactos.filter((m) => (m.delta ?? 0) < 0).length}</span>
            </div>
          </div>
          <div className="ticket-card px-5 py-4">
            <Rotulo>Soma de pts nas fatias (amostra ≥20)</Rotulo>
            <div className="mt-1 text-[28px] font-bold leading-none tabular" style={{ color: ptsGanhosMelhorias >= 0 ? "var(--positive)" : "var(--signal)" }}>
              {ptsGanhosMelhorias >= 0 ? "+" : ""}{Math.round(ptsGanhosMelhorias * 10) / 10}
            </div>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {impactos.map((m) => {
            const amostraOk = m.pares_pos >= 20;
            return (
              <div key={m.melhoria_id} className="ticket-card px-5 py-4">
                <Rotulo>
                  {agenteAmigavel(m.agente_alvo ?? "")}{m.oc_sugerida != null ? ` · oc ${m.oc_sugerida}` : ""} · no ar desde {new Date(m.mergeado_em).toLocaleDateString("pt-BR")}
                </Rotulo>
                <div className="mt-1 text-[13.5px] font-semibold text-ink-2">{m.titulo ?? "Melhoria"}</div>
                <div className="mt-3 flex flex-wrap items-baseline gap-3 font-mono tabular">
                  <span className="text-[20px] font-bold text-ink-mute">{m.pct_pre != null ? `${m.pct_pre}%` : "—"}</span>
                  <span className="text-ink-mute">→</span>
                  <span className="text-[20px] font-bold" style={{ color: m.delta == null ? undefined : m.delta >= 0 ? "var(--positive)" : "var(--signal)" }}>
                    {m.pct_pos != null ? `${m.pct_pos}%` : "—"}
                  </span>
                  {m.delta != null && (
                    <span className="text-[12px] font-bold" style={{ color: m.delta >= 0 ? "var(--positive)" : "var(--signal)" }}>
                      {m.delta >= 0 ? "▲ +" : "▼ "}{m.delta} pts
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-ink-mute">
                  {m.pares_pre} pares antes · {m.pares_pos} depois
                  {!amostraOk && <span style={{ color: "var(--warning)" }}> · amostra ainda pequena — aguarde ≥20 pares</span>}
                </div>
              </div>
            );
          })}
          {!melhorias.isLoading && impactos.length === 0 && (
            <div className="ticket-card col-span-full px-5 py-6 text-center text-[13px] text-ink-mute">
              {melhorias.isError ? "View v_melhorias_impacto indisponível." : "Nenhuma melhoria com merge registrado ainda — o antes × depois aparece quando a primeira for pro ar."}
            </div>
          )}
        </div>
      </Etapa>

      {/* 6 — autonomia */}
      <Etapa n={5} titulo="Autonomia — o que já pode rodar sozinho"
        sub={`Fatia (agente × oc do card × oc sugerida) com ≥${META_PCT}% e ≥50 pares vira candidata. Sinalizar não liga nada: só roda após validação expressa do Caio.`}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="ticket-card px-4 py-4">
            <div className="mb-2 text-[14px] font-bold text-ink-2">Prontas pra sinalizar</div>
            <div className="space-y-1.5">
              {candidatas.map((f) => {
                const chave = `${f.agent_name}|${f.oc_card}|${f.oc_sugerida}`;
                return (
                  <div key={chave} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-subtle px-3 py-2">
                    <span className="text-[12.5px] font-semibold text-ink-2">{agenteAmigavel(f.agent_name)}</span>
                    <span className="font-mono text-[11.5px] text-ink-soft-2">oc {f.oc_card ?? "—"} → {f.oc_sugerida}</span>
                    <span className="font-mono text-[11.5px] font-bold" style={{ color: "var(--positive)" }}>{f.pctSeguidas}% · {f.pares}</span>
                    <button onClick={() => sinalizarAutonomia(f)} disabled={promovendo === chave}
                      className="ml-auto rounded-[20px] px-2.5 py-1 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-white hover:opacity-85 disabled:opacity-40"
                      style={{ background: "var(--positive)" }}>
                      {promovendo === chave ? "sinalizando…" : "⚡ sinalizar"}
                    </button>
                  </div>
                );
              })}
              {candidatas.length === 0 && <p className="py-3 text-center text-[12.5px] text-ink-mute">Nenhuma fatia nova na régua.</p>}
            </div>
            {quaseProntas.length > 0 && (
              <>
                <div className="mb-1.5 mt-4"><Rotulo>Quase lá (≥85%, ≥20 pares)</Rotulo></div>
                <div className="space-y-1">
                  {quaseProntas.map((f) => (
                    <div key={`${f.agent_name}|${f.oc_card}|${f.oc_sugerida}`} className="flex flex-wrap items-center gap-2 px-1 text-[12px]">
                      <span className="text-ink-2">{agenteAmigavel(f.agent_name)}</span>
                      <span className="font-mono text-ink-soft-2">oc {f.oc_card ?? "—"} → {f.oc_sugerida}</span>
                      <span className="ml-auto font-mono text-ink-mute">
                        {f.pctSeguidas}% · {f.pares} pares · falta {Math.max(0, Math.round((META_PCT - (f.pctSeguidas ?? 0)) * 10) / 10)} pts{f.pares < 50 ? ` e ${50 - f.pares} pares` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="ticket-card px-4 py-4">
            <div className="mb-2 text-[14px] font-bold text-ink-2">Já registradas</div>
            <div className="space-y-1.5">
              {(autonomas.data ?? []).map((a) => (
                <div key={`${a.agent_name}|${a.oc_card}|${a.oc_sugerida}`} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-subtle px-3 py-2">
                  <span className="text-[12.5px] font-semibold text-ink-2">{agenteAmigavel(a.agent_name)}</span>
                  <span className="font-mono text-[11.5px] text-ink-soft-2">oc {a.oc_card ?? "*"} → {a.oc_sugerida}</span>
                  <span className="ml-auto rounded-[20px] px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em]"
                    style={a.ativa
                      ? { background: "var(--positive-soft)", color: "var(--positive)" }
                      : { background: "var(--warning-soft)", color: "var(--warning)" }}>
                    {a.ativa ? "⚡ rodando sozinha" : "◌ aguarda Caio"}
                  </span>
                </div>
              ))}
              {(autonomas.data ?? []).length === 0 && <p className="py-3 text-center text-[12.5px] text-ink-mute">Nenhuma fatia registrada.</p>}
            </div>
            <p className="mt-3 text-[11px] text-ink-mute">Se uma fatia ativa cair abaixo da meta, ela é rebaixada automaticamente e volta pra validação humana.</p>
          </div>
        </div>
      </Etapa>
    </div>
  );
}

/** Sugestão de treino calculada (heurística transparente, não IA): o que o
 *  padrão da troca indica e qual o próximo passo. */
function SugestaoTreino({ t }: { t: TrocaComPontos }) {
  const sug = t.oc_sugerida;
  const fez = t.oc_executada;
  let leitura: string;
  if (sug === 54 || sug === 59) {
    leitura = `o agente manda aguardar o cliente, mas o operador já age com oc ${fez} — falta ao agente o sinal que o operador usa pra não esperar.`;
  } else if (fez === 54 || fez === 59) {
    leitura = `o agente quer agir (oc ${sug}), mas o operador prefere aguardar o cliente — o agente pode estar agindo antes da confirmação.`;
  } else if (fez === 56) {
    leitura = `o operador cai em "falta informação" (56) — o agente está assumindo um dado que o card não tem.`;
  } else {
    leitura = `com o card em oc ${t.oc_card ?? "—"}, o operador prefere oc ${fez} a oc ${sug} — falta a regra que separa os dois casos.`;
  }
  return (
    <span>
      <strong className="text-ink-2">Sugestão de treino:</strong> {leitura}{" "}
      Se virar regra: {agenteAmigavel(t.agent_name)} sobe <strong style={{ color: "var(--positive)" }}>+{t.ptsAgente} pts</strong>
      {t.pctAgenteSeResolver != null && <> (até {t.pctAgenteSeResolver}%)</>}.
    </span>
  );
}
