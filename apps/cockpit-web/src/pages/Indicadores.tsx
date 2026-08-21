import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ChevronDown, ChevronUp } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { sanitizeHtml } from "@/lib/sanitizeHtml";
import { useAuth } from "@/contexts/AuthContext";
import { format } from "date-fns";
import { usePersistentState } from "@/hooks/usePersistentState";
import { IndicadorCard } from "@/components/indicadores/IndicadorCard";
import { IndicadorAcertoAgenteOc13 } from "@/components/indicadores/IndicadorAcertoAgenteOc13";
import { IndicadorAcertoAgenteOcsPadrao } from "@/components/indicadores/IndicadorAcertoAgenteOcsPadrao";



// ============================================================
// Types
// ============================================================

type LinhaIndicador = {
  id: string;
  base_responsavel: string | null;
  usuario_responsavel: string | null;
  codigo_oc_errada: number;
  codigo_oc_correta: number;
  total_erros: number;
  ultimo_erro: string;
  erros_detalhe: Array<{
    nf?: string | null;
    motivo?: string | null;
    reportado_em?: string;
    reportado_por_nome?: string | null;
  }>;
};

type CobrancaIA = {
  destinatario_sugerido: string;
  assunto_sugerido: string;
  corpo_sugerido: string;
  urgencia: "alta" | "media" | "baixa";
  canal: string;
};

type AnaliseIA = {
  resumo_geral: string;
  metricas_chave?: Array<{
    label: string;
    valor: string;
    delta_pct?: number;
    tendencia?: "melhorando" | "piorando" | "estavel";
  }>;
  melhoria_destaques?: Array<{ base: string; descricao: string; evidencia?: string }>;
  piora_destaques?: Array<{
    base: string;
    descricao: string;
    evidencia?: string;
    severidade?: "alta" | "media" | "baixa";
  }>;
  sugestoes_melhoria?: Array<{
    titulo: string;
    descricao: string;
    base_alvo?: string;
    prioridade?: "alta" | "media" | "baixa";
  }>;
  sugestoes_automacao?: Array<{
    titulo: string;
    descricao: string;
    escopo?: string;
    dificuldade?: string;
  }>;
  cobrancas_recomendadas?: CobrancaIA[];
  evidencia_incompleta_sub_tipos?: Array<{
    sub_tipo: string;
    total: number;
    exemplos_textuais?: string[];
  }>;
};

// ============================================================
// Filtros chips
// ============================================================

const PERIODOS: { label: string; dias: number | null }[] = [
  { label: "7 dias", dias: 7 },
  { label: "30 dias", dias: 30 },
  { label: "90 dias", dias: 90 },
  { label: "Todos", dias: null },
];

function urgenciaBadge(u: string | undefined) {
  if (u === "alta")
    return "bg-red-50 text-red-700 border-red-200";
  if (u === "media")
    return "bg-orange-50 text-orange-700 border-orange-200";
  return "bg-yellow-50 text-yellow-800 border-yellow-200";
}

function totalBadge(n: number) {
  if (n > 10) return "bg-red-50 text-red-700 border-red-200";
  if (n >= 5) return "bg-orange-50 text-orange-700 border-orange-200";
  return "bg-yellow-50 text-yellow-800 border-yellow-200";
}

function relativo(iso: string) {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ptBR });
  } catch {
    return iso;
  }
}

// ============================================================
// Card: Erros de Lançamento da Base
// ============================================================

const SUB_TIPO_LABELS: Record<string, string> = {
  FOTO_DESFOCADA_OU_ILEGIVEL: "Foto desfocada / ilegível",
  FOTO_NAO_MOSTRA_OCORRENCIA: "Foto não evidencia a ocorrência",
  FOTO_DE_OUTRA_NF_OU_PEDIDO: "Foto de outra NF / pedido",
  SEM_ASSINATURA_OU_ASSINATURA_ILEGIVEL: "Sem assinatura / ilegível",
  ENDERECO_INCORRETO_VISIVEL: "Endereço errado na evidência",
  INFORMACAO_INCOMPLETA_NA_OBSERVACAO: "Observação incompleta",
  OUTRO: "Outro motivo",
};

function EvidenciaIncompletaSubTipos({
  itens,
}: {
  itens: NonNullable<AnaliseIA["evidencia_incompleta_sub_tipos"]>;
}) {
  const [expandidos, setExpandidos] = useState<Record<string, boolean>>({});
  const ordenados = [...itens].sort((a, b) => b.total - a.total);
  const maxTotal = Math.max(...ordenados.map((i) => i.total), 1);

  return (
    <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50/30 p-4">
      <div className="mb-3 text-[12px] font-bold text-amber-800">
        📋 Sub-tipos de Evidência Incompleta
      </div>
      <ul className="space-y-1.5">
        {ordenados.map((it) => {
          const label = SUB_TIPO_LABELS[it.sub_tipo] ?? it.sub_tipo;
          const pct = (it.total / maxTotal) * 100;
          const exp = !!expandidos[it.sub_tipo];
          const temExemplos = (it.exemplos_textuais?.length ?? 0) > 0;
          return (
            <li key={it.sub_tipo} className="rounded border border-amber-100 bg-white">
              <button
                type="button"
                disabled={!temExemplos}
                onClick={() =>
                  setExpandidos((p) => ({ ...p, [it.sub_tipo]: !p[it.sub_tipo] }))
                }
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-amber-50/50 disabled:cursor-default"
              >
                <span className="min-w-[180px] text-[12px] text-ink">{label}</span>
                <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-amber-100">
                  <span
                    className="absolute inset-y-0 left-0 bg-amber-500"
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="min-w-[24px] text-right font-mono text-[12px] font-bold text-amber-800">
                  {it.total}
                </span>
                {temExemplos && (
                  <span className="font-mono text-[10px] text-amber-700">{exp ? "▼" : "▶"}</span>
                )}
              </button>
              {exp && temExemplos && (
                <ul className="border-t border-amber-100 bg-amber-50/40 px-4 py-2 space-y-0.5">
                  {it.exemplos_textuais!.slice(0, 5).map((ex, i) => (
                    <li
                      key={i}
                      className="font-display text-[11px] italic text-ink-soft"
                    >
                      "{ex}"
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function IndicadorErrosLancamento() {
  const qc = useQueryClient();
  const [periodoDias, setPeriodoDias] = useState<number | null>(30);
  const [basesSelecionadas, setBasesSelecionadas] = useState<string[]>([]);
  const [operadoresSelecionados, setOperadoresSelecionados] = useState<string[]>([]);
  const [analiseIA, setAnaliseIA] = useState<AnaliseIA | null>(null);
  const [analiseGeradoEm, setAnaliseGeradoEm] = useState<string | null>(null);
  const [analiseCarregando, setAnaliseCarregando] = useState(false);
  const [expandida, setExpandida] = useState<Record<string, boolean>>({});
  const [cobrancaEditando, setCobrancaEditando] = useState<CobrancaIA | null>(null);
  const [modalRelatorio, setModalRelatorio] = useState(false);
  const [iaExpanded, setIaExpanded] = usePersistentState<boolean>(
    "indicador_erros_lancamento_base_ia_expanded",
    false,
  );

  const dataInicio = periodoDias
    ? new Date(Date.now() - periodoDias * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const { data: linhas, isLoading } = useQuery({
    queryKey: ["indicador-erros-lancamento", periodoDias, basesSelecionadas, operadoresSelecionados],
    enabled: !!supabase,
    queryFn: async () => {
      let q = supabase!
        .from("v_indicador_erros_lancamento_base")
        .select("*")
        .order("total_erros", { ascending: false });
      if (dataInicio) q = q.gte("ultimo_erro", dataInicio);
      if (basesSelecionadas.length) q = q.in("base_responsavel", basesSelecionadas);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as LinhaIndicador[];
    },
  });

  // Bases e operadores para filtros (extraídos das linhas atuais + raw table p/ completude)
  const { data: opcoesFiltro } = useQuery({
    queryKey: ["indicador-erros-opcoes"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data } = await supabase!
        .from("erros_lancamento_ssw")
        .select("base_responsavel, reportado_por_nome")
        .limit(500);
      const bases = new Set<string>();
      const operadores = new Set<string>();
      (data ?? []).forEach((r: any) => {
        if (r.base_responsavel) bases.add(r.base_responsavel);
        if (r.reportado_por_nome) operadores.add(r.reportado_por_nome);
      });
      return {
        bases: Array.from(bases).sort(),
        operadores: Array.from(operadores).sort(),
      };
    },
  });

  // KPIs derivados
  const kpis = useMemo(() => {
    const ls = linhas ?? [];
    const total = ls.reduce((acc, l) => acc + Number(l.total_erros), 0);
    const porBase: Record<string, number> = {};
    const porErro: Record<string, number> = {};
    ls.forEach((l) => {
      const b = l.base_responsavel ?? "—";
      porBase[b] = (porBase[b] ?? 0) + Number(l.total_erros);
      const k = `${l.codigo_oc_errada} → ${l.codigo_oc_correta}`;
      porErro[k] = (porErro[k] ?? 0) + Number(l.total_erros);
    });
    const [baseTop] = Object.entries(porBase).sort((a, b) => b[1] - a[1]);
    const [erroTop] = Object.entries(porErro).sort((a, b) => b[1] - a[1]);
    return {
      total,
      baseTop: baseTop ?? null,
      erroTop: erroTop ?? null,
    };
  }, [linhas]);

  // Análise IA: chama 1x ao montar e em mudança de filtros (com cache)
  async function fetchIA(forcar = false) {
    if (!supabase) return;
    setAnaliseCarregando(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "analisar-indicador-erros-lancamento",
        {
          body: {
            filtro_periodo_dias: periodoDias,
            filtro_bases: basesSelecionadas,
            filtro_operadores: operadoresSelecionados,
            forcar_refresh: forcar,
          },
        },
      );
      if (error || !data?.ok) {
        toast.error("Falha ao analisar com IA: " + (error?.message ?? data?.error ?? "erro"));
        return;
      }
      setAnaliseIA(data.resultado as AnaliseIA);
      setAnaliseGeradoEm(data.gerado_em ?? null);
    } finally {
      setAnaliseCarregando(false);
    }
  }

  useEffect(() => {
    fetchIA(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodoDias, basesSelecionadas.join(","), operadoresSelecionados.join(",")]);

  async function enviarCobrancaIA(cobranca: CobrancaIA) {
    const destinatariosInput = window.prompt(
      "Confirme os destinatários (separados por vírgula):",
      cobranca.destinatario_sugerido.includes("@") ? cobranca.destinatario_sugerido : "",
    );
    if (!destinatariosInput) return;
    const destinatarios = destinatariosInput
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.includes("@"));
    if (destinatarios.length === 0) {
      toast.error("Informe pelo menos 1 email válido");
      return;
    }
    const { data, error } = await supabase!.functions.invoke("enviar-cobranca-base", {
      body: {
        destinatarios,
        assunto: cobranca.assunto_sugerido,
        corpo_html: cobranca.corpo_sugerido,
        canal: "email",
        indicador_tipo: "erros_lancamento_base",
        sugerido_por_ia: true,
      },
    });
    if (data?.ok) toast.success(data.mensagem ?? "Cobrança enviada");
    else toast.error(data?.error ?? error?.message ?? "Falha ao enviar");
  }

  function toggleBase(b: string) {
    setBasesSelecionadas((prev) =>
      prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b],
    );
  }
  function toggleOperador(o: string) {
    setOperadoresSelecionados((prev) =>
      prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o],
    );
  }

  const totalErros = kpis.total;
  const resumoHeader = !linhas?.length ? (
    "Sem dados — clique expandir pra ver empty state"
  ) : (
    <>
      <strong className="text-ink">{totalErros}</strong> erro{totalErros === 1 ? "" : "s"} no período ·{" "}
      Base mais errante: <strong className="text-ink">{kpis.baseTop?.[0] ?? "—"}</strong> ·{" "}
      Mais comum: <strong className="text-ink">oc={kpis.erroTop?.[0] ?? "—"}</strong>
    </>
  );

  return (
    <IndicadorCard
      nome="erros_lancamento"
      icone="📊"
      titulo="Erros de Lançamento da Base"
      subtitulo="Identifica quais bases estão errando mais ao lançar ocorrências no SSW"
      resumoHeader={resumoHeader}
      acoesHeader={
        <button
          onClick={() => setModalRelatorio(true)}
          className="border border-ink bg-paper px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-ink hover:bg-paper-deep"
        >
          📧 Enviar relatório
        </button>
      }
    >
      


      {/* Filtros */}
      <div className="mb-5 flex flex-wrap items-center gap-3 border-y border-gray-100 py-3">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
          ⏱ Período:
        </span>
        <div className="flex gap-1">
          {PERIODOS.map((p) => (
            <button
              key={p.label}
              onClick={() => setPeriodoDias(p.dias)}
              className={
                "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors " +
                (periodoDias === p.dias
                  ? "border-ink bg-ink text-paper"
                  : "border-gray-300 bg-white text-ink-soft hover:border-ink")
              }
            >
              {p.label}
            </button>
          ))}
        </div>

        {(opcoesFiltro?.bases?.length ?? 0) > 0 && (
          <>
            <span className="ml-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              🏢 Bases:
            </span>
            <div className="flex flex-wrap gap-1">
              {opcoesFiltro!.bases.map((b) => (
                <button
                  key={b}
                  onClick={() => toggleBase(b)}
                  className={
                    "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors " +
                    (basesSelecionadas.includes(b)
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-gray-300 bg-white text-ink-soft hover:border-ink")
                  }
                >
                  {b}
                </button>
              ))}
            </div>
          </>
        )}

        {(opcoesFiltro?.operadores?.length ?? 0) > 0 && (
          <>
            <span className="ml-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              👤 Reportou:
            </span>
            <div className="flex flex-wrap gap-1">
              {opcoesFiltro!.operadores.map((o) => (
                <button
                  key={o}
                  onClick={() => toggleOperador(o)}
                  className={
                    "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors " +
                    (operadoresSelecionados.includes(o)
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-gray-300 bg-white text-ink-soft hover:border-ink")
                  }
                >
                  {o}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* KPIs */}
      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-3">
        <KpiCard
          label="Total no período"
          valor={String(kpis.total)}
          tooltip="Soma de todos os reports de erro de lançamento no período/filtro atual."
        />
        <KpiCard
          label="Base que mais erra"
          valor={kpis.baseTop ? kpis.baseTop[0] : "—"}
          sub={kpis.baseTop ? `${kpis.baseTop[1]} erro(s)` : undefined}
          tooltip="Base com maior número total de ocorrências reportadas como erradas."
        />
        <KpiCard
          label="Erro mais comum"
          valor={kpis.erroTop ? `oc=${kpis.erroTop[0]}` : "—"}
          sub={kpis.erroTop ? `${kpis.erroTop[1]} vez(es)` : undefined}
          tooltip="Combinação de OC errada → OC correta que mais aparece."
        />
      </div>

      {/* Análise IA */}
      {(() => {
        const totalSugestoes =
          (analiseIA?.sugestoes_melhoria?.length ?? 0) +
          (analiseIA?.sugestoes_automacao?.length ?? 0);
        const totalCobrancas = analiseIA?.cobrancas_recomendadas?.length ?? 0;
        const temUrgenciaAlta = !!analiseIA?.cobrancas_recomendadas?.some(
          (c) => c.urgencia === "alta",
        );
        return (
          <div className="mb-5 rounded-lg border border-indigo-200 bg-indigo-50/30">
            <button
              type="button"
              onClick={() => setIaExpanded(!iaExpanded)}
              className="flex w-full items-start justify-between gap-3 p-4 text-left hover:bg-indigo-50/60 transition-colors"
              aria-expanded={iaExpanded}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[12px] font-bold text-indigo-700">
                  <span>🤖 Análise IA</span>
                  {temUrgenciaAlta && <span title="Há cobranças urgentes">🔴</span>}
                </div>
                {analiseIA && (
                  <div className="mt-0.5 text-[11px] text-indigo-600/80">
                    {totalSugestoes} sugest{totalSugestoes === 1 ? "ão" : "ões"} de melhoria ·{" "}
                    {totalCobrancas} cobrança{totalCobrancas === 1 ? "" : "s"} recomendada
                    {totalCobrancas === 1 ? "" : "s"}
                    {analiseGeradoEm && <> · {relativo(analiseGeradoEm)}</>}
                  </div>
                )}
                {!analiseIA && (
                  <div className="mt-0.5 text-[11px] text-indigo-600/80">
                    {analiseCarregando ? "Analisando..." : "Clique para expandir"}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    fetchIA(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!analiseCarregando) fetchIA(true);
                    }
                  }}
                  aria-disabled={analiseCarregando}
                  className={
                    "border border-indigo-400 bg-white px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-indigo-700 hover:bg-indigo-100 " +
                    (analiseCarregando ? "opacity-50 pointer-events-none" : "cursor-pointer")
                  }
                >
                  {analiseCarregando ? "⏳ Analisando..." : "🔄 Reanalizar"}
                </span>
                <span className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-widest text-indigo-700">
                  {iaExpanded ? (
                    <>
                      <ChevronUp className="h-3 w-3" /> Recolher
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3 w-3" /> Expandir
                    </>
                  )}
                </span>
              </div>
            </button>

            <div
              className="grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out"
              style={{ gridTemplateRows: iaExpanded ? "1fr" : "0fr" }}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="border-t border-indigo-200 p-4">
                  {analiseCarregando && !analiseIA && <SkeletonAnaliseIA />}

                  {analiseIA && (
                    <div className="space-y-4">
            {analiseIA.resumo_geral && (
              <p className="text-[13px] leading-relaxed text-ink">{analiseIA.resumo_geral}</p>
            )}

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {(analiseIA.melhoria_destaques?.length ?? 0) > 0 && (
                <div className="rounded border border-green-200 bg-green-50/50 p-3">
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-green-700">
                    📈 Melhorando
                  </div>
                  <ul className="space-y-1 text-[12px] text-ink">
                    {analiseIA.melhoria_destaques!.map((m, i) => (
                      <li key={i}>
                        • <strong>{m.base}:</strong> {m.descricao}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(analiseIA.piora_destaques?.length ?? 0) > 0 && (
                <div className="rounded border border-red-200 bg-red-50/50 p-3">
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-red-700">
                    📉 Piorando
                  </div>
                  <ul className="space-y-1 text-[12px] text-ink">
                    {analiseIA.piora_destaques!.map((p, i) => (
                      <li key={i}>
                        • <strong>{p.base}:</strong> {p.descricao}{" "}
                        {p.severidade === "alta" && <span className="text-red-600">🔴</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {(analiseIA.sugestoes_melhoria?.length ?? 0) > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-ink">
                  💡 Sugestões de melhoria
                </div>
                <ul className="space-y-1">
                  {analiseIA.sugestoes_melhoria!.map((s, i) => (
                    <SugestaoItem
                      key={i}
                      titulo={s.titulo}
                      descricao={s.descricao}
                      info={s.base_alvo}
                      prioridade={s.prioridade}
                    />
                  ))}
                </ul>
              </div>
            )}

            {(analiseIA.sugestoes_automacao?.length ?? 0) > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-ink">
                  🤖 Sugestões de automação
                </div>
                <ul className="space-y-1">
                  {analiseIA.sugestoes_automacao!.map((s, i) => (
                    <SugestaoItem
                      key={i}
                      titulo={s.titulo}
                      descricao={s.descricao}
                      info={[s.escopo, s.dificuldade ? `dificuldade ${s.dificuldade}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                      prioridade={s.dificuldade as any}
                    />
                  ))}
                </ul>
              </div>
            )}

            {(analiseIA.cobrancas_recomendadas?.length ?? 0) > 0 && (
              <div>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-widest text-ink">
                  📧 Cobranças recomendadas pela IA
                </div>
                <div className="space-y-2">
                  {analiseIA.cobrancas_recomendadas!.map((c, i) => (
                    <div
                      key={i}
                      className="rounded border border-gray-200 bg-white p-3 shadow-sm"
                    >
                      <div className="mb-1.5 flex items-center gap-2 text-[11px]">
                        <span
                          className={
                            "rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase " +
                            urgenciaBadge(c.urgencia)
                          }
                        >
                          {c.urgencia === "alta" ? "🔴" : c.urgencia === "media" ? "🟠" : "🟡"}{" "}
                          {c.urgencia}
                        </span>
                        <span className="text-ink-soft">Pra:</span>
                        <strong className="text-ink">{c.destinatario_sugerido}</strong>
                      </div>
                      <div className="mb-2 text-[12px] text-ink">
                        <span className="text-ink-soft">Assunto: </span>
                        {c.assunto_sugerido}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <details className="inline">
                          <summary className="inline-flex cursor-pointer items-center border border-ink/30 bg-paper px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-ink hover:border-ink">
                            📄 Pré-visualizar
                          </summary>
                          <div
                            className="mt-2 max-h-64 overflow-auto rounded border border-gray-200 bg-gray-50 p-3 text-[12px] leading-relaxed"
                            dangerouslySetInnerHTML={{ __html: sanitizeHtml(c.corpo_sugerido) }}
                          />
                        </details>
                        <button
                          onClick={() => enviarCobrancaIA(c)}
                          className="border border-good bg-good px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-paper hover:bg-good/90"
                        >
                          📤 Enviar como está
                        </button>
                        <button
                          onClick={() => setCobrancaEditando(c)}
                          className="border border-ink bg-paper px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-ink hover:bg-paper-deep"
                        >
                          ✏️ Editar antes
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {(analiseIA?.evidencia_incompleta_sub_tipos?.length ?? 0) > 0 && (
        <EvidenciaIncompletaSubTipos itens={analiseIA!.evidencia_incompleta_sub_tipos!} />
      )}



      {/* Tabela detalhada */}
      <div className="rounded-lg border border-gray-200">
        <div className="border-b border-gray-200 bg-gray-50 px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-ink-soft">
          Detalhamento
        </div>
        {isLoading ? (
          <SkeletonTabela />
        ) : !linhas || linhas.length === 0 ? (
          <EmptyState />
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50/60 text-left font-mono text-[10px] uppercase tracking-widest text-ink-soft">
                <th className="px-3 py-2 w-6"></th>
                <th className="px-3 py-2">Base</th>
                <th className="px-3 py-2">Usuário SSW</th>
                <th className="px-3 py-2">Erro</th>
                <th className="px-3 py-2">Total</th>
                <th className="px-3 py-2">Última vez</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l, idx) => {
                const exp = !!expandida[l.id];
                return (
                  <>
                    <tr
                      key={l.id}
                      className={
                        "cursor-pointer border-b border-gray-100 hover:bg-gray-50/60 " +
                        (idx % 2 === 0 ? "" : "bg-gray-50/30")
                      }
                      onClick={() =>
                        setExpandida((p) => ({ ...p, [l.id]: !p[l.id] }))
                      }
                    >
                      <td className="px-3 py-2 text-ink-soft">
                        <span
                          className={
                            "inline-block transition-transform " +
                            (exp ? "rotate-90" : "")
                          }
                        >
                          ▶
                        </span>
                      </td>
                      <td className="px-3 py-2 font-semibold text-ink">
                        {l.base_responsavel ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink">
                        {l.usuario_responsavel ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-ink">
                        <span className="font-mono">{l.codigo_oc_errada}</span>
                        <span className="mx-1 text-ink-soft">→</span>
                        <span className="font-mono font-bold">{l.codigo_oc_correta}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            "rounded-full border px-2 py-0.5 text-[11px] font-bold " +
                            totalBadge(Number(l.total_erros))
                          }
                        >
                          {l.total_erros}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-ink-soft">{relativo(l.ultimo_erro)}</td>
                    </tr>
                    {exp && (
                      <tr key={l.id + "-exp"} className="border-b border-gray-200 bg-blue-50/30">
                        <td></td>
                        <td colSpan={5} className="px-3 py-2">
                          <ul className="space-y-1 text-[12px] text-ink">
                            {(l.erros_detalhe ?? []).map((d, i) => (
                              <li key={i}>
                                • NF <strong>{d.nf ?? "—"}</strong>
                                {d.motivo ? <>, motivo "{d.motivo}"</> : <>, sem motivo</>}
                                {d.reportado_por_nome && <>, {d.reportado_por_nome}</>}
                                {d.reportado_em && <> {relativo(d.reportado_em)}</>}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {cobrancaEditando && (
        <ModalEditarCobranca
          cobranca={cobrancaEditando}
          onClose={() => setCobrancaEditando(null)}
          onEnviado={() => {
            setCobrancaEditando(null);
            qc.invalidateQueries({ queryKey: ["indicador-erros-lancamento"] });
          }}
        />
      )}

      {modalRelatorio && (
        <ModalEnviarRelatorio
          linhas={linhas ?? []}
          onClose={() => setModalRelatorio(false)}
        />
      )}
    </IndicadorCard>
  );
}

// ============================================================
// Sub-components
// ============================================================

function KpiCard({
  label,
  valor,
  sub,
  tooltip,
}: {
  label: string;
  valor: string;
  sub?: string;
  tooltip?: string;
}) {
  return (
    <div
      className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
      title={tooltip}
    >
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
        {label}
      </div>
      <div className="mt-1 text-3xl font-bold text-ink">{valor}</div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-soft">{sub}</div>}
    </div>
  );
}

function SugestaoItem({
  titulo,
  descricao,
  info,
  prioridade,
}: {
  titulo: string;
  descricao: string;
  info?: string;
  prioridade?: "alta" | "media" | "baixa";
}) {
  const [aberto, setAberto] = useState(false);
  const icon = prioridade === "alta" ? "🔴" : prioridade === "media" ? "🟠" : "🟡";
  return (
    <li className="rounded border border-gray-200 bg-white p-2 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink">
          {icon} {titulo}
        </span>
        <button
          onClick={() => setAberto((v) => !v)}
          className="font-mono text-[10px] text-blue-600 hover:underline"
        >
          {aberto ? "Ocultar" : "Detalhes"}
        </button>
      </div>
      {aberto && (
        <div className="mt-1.5 border-t border-gray-100 pt-1.5 text-[12px] text-ink-soft">
          {descricao}
          {info && <div className="mt-1 font-mono text-[10px]">↳ {info}</div>}
        </div>
      )}
    </li>
  );
}

function SkeletonAnaliseIA() {
  return (
    <div className="space-y-2">
      <div className="h-3 w-3/4 animate-pulse rounded bg-gray-200" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-gray-200" />
      <div className="grid grid-cols-2 gap-3 pt-2">
        <div className="h-20 animate-pulse rounded bg-gray-100" />
        <div className="h-20 animate-pulse rounded bg-gray-100" />
      </div>
    </div>
  );
}

function SkeletonTabela() {
  return (
    <div className="space-y-2 p-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded bg-gray-100" />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <div className="text-5xl opacity-30">📊</div>
      <p className="mt-3 max-w-md text-[13px] text-ink-soft">
        Ainda não há erros reportados. Comece reportando do botão ⚠️ no histórico SSW de
        qualquer card.
      </p>
    </div>
  );
}

function ModalEditarCobranca({
  cobranca,
  onClose,
  onEnviado,
}: {
  cobranca: CobrancaIA;
  onClose: () => void;
  onEnviado: () => void;
}) {
  const [para, setPara] = useState(cobranca.destinatario_sugerido);
  const [assunto, setAssunto] = useState(cobranca.assunto_sugerido);
  const [corpo, setCorpo] = useState(cobranca.corpo_sugerido);
  const [enviando, setEnviando] = useState(false);

  async function enviar() {
    const destinatarios = para
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.includes("@"));
    if (destinatarios.length === 0) {
      toast.error("Informe pelo menos 1 email válido em 'Para'");
      return;
    }
    setEnviando(true);
    const { data, error } = await supabase!.functions.invoke("enviar-cobranca-base", {
      body: {
        destinatarios,
        assunto,
        corpo_html: corpo,
        canal: "email",
        indicador_tipo: "erros_lancamento_base",
        sugerido_por_ia: true,
      },
    });
    setEnviando(false);
    if (data?.ok) {
      toast.success(data.mensagem ?? "Cobrança enviada");
      onEnviado();
    } else {
      toast.error(data?.error ?? error?.message ?? "Falha ao enviar");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border-2 border-ink bg-paper p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-[16px] font-bold">✏️ Editar cobrança antes de enviar</h3>
          <button onClick={onClose} className="text-ink-soft hover:text-ink">
            ✕
          </button>
        </div>
        <label className="mb-2 block">
          <span className="block text-[10px] font-bold uppercase tracking-widest text-ink-soft">Para</span>
          <textarea
            value={para}
            onChange={(e) => setPara(e.target.value)}
            rows={2}
            className="w-full border border-ink bg-paper px-2 py-1 font-mono text-[12px]"
            placeholder="email1@dominio.com, email2@dominio.com"
          />
        </label>
        <label className="mb-2 block">
          <span className="block text-[10px] font-bold uppercase tracking-widest text-ink-soft">Assunto</span>
          <input
            value={assunto}
            onChange={(e) => setAssunto(e.target.value)}
            className="w-full border border-ink bg-paper px-2 py-1 text-[13px]"
          />
        </label>
        <label className="mb-3 block">
          <span className="block text-[10px] font-bold uppercase tracking-widest text-ink-soft">
            Corpo (HTML)
          </span>
          <textarea
            value={corpo}
            onChange={(e) => setCorpo(e.target.value)}
            rows={10}
            className="w-full border border-ink bg-paper px-2 py-1 font-mono text-[11px] leading-relaxed"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="border-2 border-ink bg-paper px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest"
          >
            Cancelar
          </button>
          <button
            onClick={enviar}
            disabled={enviando}
            className="border-2 border-ink bg-good px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-paper disabled:opacity-50"
          >
            {enviando ? "Enviando..." : "📤 Enviar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalEnviarRelatorio({
  linhas,
  onClose,
}: {
  linhas: LinhaIndicador[];
  onClose: () => void;
}) {
  const [para, setPara] = useState("");
  const [assunto, setAssunto] = useState(
    "Relatório de erros de lançamento — Base " + new Date().toLocaleDateString("pt-BR"),
  );
  const [enviando, setEnviando] = useState(false);

  const previewHtml = useMemo(() => {
    const rows = linhas
      .map(
        (l) =>
          `<tr><td>${l.base_responsavel ?? "—"}</td><td>${l.usuario_responsavel ?? "—"}</td><td>${l.codigo_oc_errada} → ${l.codigo_oc_correta}</td><td>${l.total_erros}</td></tr>`,
      )
      .join("");
    return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px"><thead><tr><th>Base</th><th>Usuário</th><th>Erro</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>`;
  }, [linhas]);

  async function enviar() {
    const destinatarios = para
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.includes("@"));
    if (destinatarios.length === 0) {
      toast.error("Informe pelo menos 1 email válido");
      return;
    }
    setEnviando(true);
    const { data, error } = await supabase!.functions.invoke("enviar-cobranca-base", {
      body: {
        destinatarios,
        assunto,
        corpo_html: previewHtml,
        canal: "email",
        indicador_tipo: "erros_lancamento_base",
        sugerido_por_ia: false,
      },
    });
    setEnviando(false);
    if (data?.ok) {
      toast.success(data.mensagem ?? "Relatório enviado");
      onClose();
    } else {
      toast.error(data?.error ?? error?.message ?? "Falha ao enviar");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border-2 border-ink bg-paper p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-[16px] font-bold">📧 Enviar relatório</h3>
          <button onClick={onClose} className="text-ink-soft hover:text-ink">
            ✕
          </button>
        </div>
        <label className="mb-2 block">
          <span className="block text-[10px] font-bold uppercase tracking-widest text-ink-soft">
            Para (emails separados por vírgula)
          </span>
          <textarea
            value={para}
            onChange={(e) => setPara(e.target.value)}
            rows={2}
            className="w-full border border-ink bg-paper px-2 py-1 font-mono text-[12px]"
          />
        </label>
        <label className="mb-3 block">
          <span className="block text-[10px] font-bold uppercase tracking-widest text-ink-soft">
            Assunto
          </span>
          <input
            value={assunto}
            onChange={(e) => setAssunto(e.target.value)}
            className="w-full border border-ink bg-paper px-2 py-1 text-[13px]"
          />
        </label>
        <div className="mb-3">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-ink-soft">
            Preview
          </span>
          <div
            className="max-h-64 overflow-auto rounded border border-gray-200 bg-gray-50 p-3"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(previewHtml) }}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="border-2 border-ink bg-paper px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest"
          >
            Cancelar
          </button>
          <button
            onClick={enviar}
            disabled={enviando}
            className="border-2 border-ink bg-good px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-paper disabled:opacity-50"
          >
            {enviando ? "Enviando..." : "📤 Enviar"}
          </button>
        </div>
      </div>
    </div>
  );
}




// ============================================================
// Page
// ============================================================

export default function Indicadores() {
  return (
    <div className="h-full overflow-y-auto bg-paper-deep/30 px-6 py-5">
      <header className="mb-5">
        <h1 className="font-display text-[24px] font-bold text-ink">📊 Indicadores</h1>
        <p className="text-[12px] text-ink-soft">
          Métricas operacionais com análise IA e ações de cobrança.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-5">
        <IndicadorErrosLancamento />
        <IndicadorAcertoAgenteOc13 />
        <IndicadorAcertoAgenteOcsPadrao />

      </div>
    </div>
  );
}
