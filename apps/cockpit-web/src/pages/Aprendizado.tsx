import { useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  CheckCircle2,
  ChevronDown,
  GraduationCap,
  Info,
  MessageCircleQuestion,
  Paperclip,
  Sparkle,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// ============================================================
// Painel "IA / Aprendizado" — Loop de Aprendizado dos agentes.
// Spec: docs/superpowers/specs/2026-07-17-loop-aprendizado-agentes-design.md
// Iteração 2 (prints Caio 2026-07-17): casos com o porquê da IA + linha do
// tempo do card, trocas clicáveis com contexto, explicação de cada agente,
// e dashboards de verdade (evolução semanal, volumes, custo do agente-chefe).
// ============================================================

const ALLOWLIST_EMAILS = [
  "caio@salexpress.com.br",
  "isadora.baldoni@salexpress.com.br", // Isadora responde as perguntas (Caio 2026-07-23)
];
const JANELA_PLACAR_DIAS = 30;
const JANELA_GRAFICO_DIAS = 60;

// Eventos de infraestrutura que só poluem a linha do tempo do caso
const EVENTOS_RUIDO =
  '("HistoricoSswPuxado","CobrancaAdiadaSemContato","BounceDetectado","MensagemAnexadaPorThread","AutoProposicaoAdiadaSemChaveCTe","DivergenciaBastaoVsTrackingResolvida")';

// ============================================================
// Types
// ============================================================

type MetricaDiaria = {
  dia: string;
  agent_name: string;
  pares: number;
  seguidas: number;
  corrigidas: number;
  abstencoes: number;
};

type PorQueIA = {
  observacao: string | null;
  motivo_extraido: string | null;
  confianca: number | null;
  foto_classificacao: string | null;
  ressalva_texto: string | null;
};

type CasoDetalheT = {
  nf: string | null;
  card_id: string;
  quando: string;
  oc_card: number | null;
  oc_executada: number | null;
  operador: string | null;
  cliente: string | null;
  motivo_correcao: string | null;
  por_que_ia: PorQueIA;
};

type FollowupOpcaoT = { id: string; rotulo: string };
type FollowupT = {
  pergunta: string;
  opcoes: FollowupOpcaoT[];
  multi?: boolean;
  exige_imagem?: boolean;
  pede_imagem?: boolean;
  permite_texto?: boolean;
  texto_rotulo?: string;
};
type OpcaoV2T = { id: string; rotulo: string; followup?: FollowupT };

type PerguntaRow = {
  id: string;
  titulo: string;
  resumo: string | null;
  created_at: string;
  detalhes: {
    pergunta?: string;
    o_que_sugiro?: string;
    opcoes?: string[];
    opcoes_v2?: OpcaoV2T[];
    casos_ancora?: string[];
    casos_detalhe?: CasoDetalheT[];
    numeros?: Record<string, number>;
  } | null;
};

type RelatorioRow = {
  id: string;
  titulo: string;
  resumo: string | null;
  created_at: string;
  detalhes: {
    comparativo?: Array<{
      agenteAmigavel: string;
      paresAtual: number;
      pctAcertoAtual: number | null;
      deltaPontos: number | null;
    }>;
  } | null;
};

type RespostaRow = { id: string; titulo: string; resumo: string | null };

type TrocaRow = {
  agent_name: string;
  oc_sugerida: number | null;
  oc_executada: number | null;
  casos: number;
};

type EventoTimeline = {
  id: string;
  narrativa: string | null;
  event_type: string;
  ator_nome: string | null;
  created_at: string;
};

const AGENTE_AMIGAVEL: Record<string, string> = {
  "agente-sugere-ocs-padrao": "Agente de recusas",
  "interpretador-resposta-cliente": "Leitor de respostas do cliente",
  "agente-oc13-autonomo": "Agente de limitação do cliente",
  "agente-extravio-d4": "Agente de extravios",
  "agente-ressarcimento-relancar-54": "Agente de ressarcimento",
};

// "O que cada agente faz" — pedido Caio 2026-07-17 (sem poluir: fica dobrado)
const AGENTE_INFO: Record<
  string,
  { monitora: string; sugere: string; lanca: string; gatilho: string }
> = {
  "agente-sugere-ocs-padrao": {
    monitora:
      "Cards que chegam com recusa ou falta na entrega: 10 (recusa total), 11 (problema de endereço), 19 (falta de volumes) e 35 (recusa parcial).",
    sugere:
      "Lê a foto do canhoto/ressalva da entrega e monta as opções: notificar o cliente (54 + e-mail com o template certo), pedir informação à operação (56) ou pedir documentação de ressarcimento (59).",
    lanca: "Nada sozinho — toda ação passa pela aprovação de um operador.",
    gatilho: "Roda a cada 5 minutos sobre os cards novos dessas ocorrências.",
  },
  "interpretador-resposta-cliente": {
    monitora: "Toda resposta de cliente que chega por e-mail num card.",
    sugere:
      "Interpreta o que o cliente escreveu e sugere a próxima ocorrência: reentrega (21), reversa (33), retorno (44), aguardar retorno (54), liberar entrega (55) ou falta de informação (56) — com a instrução preenchida.",
    lanca: "Nada sozinho — o operador aprova (ou corrige) a sugestão.",
    gatilho: "Dispara na hora em que a resposta do cliente é capturada.",
  },
  "agente-oc13-autonomo": {
    monitora:
      "Cards de limitação do cliente (13) de clientes previamente autorizados na lista de exceção.",
    sugere:
      "Classifica a foto da ocorrência e decide: sugerir notificação ao cliente (54 + e-mail), pedir informação (56) ou reentrega (21) com cancelamento da reentrega anterior.",
    lanca:
      "Pode lançar a 21 + cancelar reentrega SOZINHO, mas só quando a foto comprova e o cliente está na lista — senão vira sugestão.",
    gatilho: "Roda a cada 5 minutos sobre os cards de oc 13 elegíveis.",
  },
};

const CORES_AGENTE: Record<string, string> = {
  "interpretador-resposta-cliente": "#3E5C94",
  "agente-sugere-ocs-padrao": "#C05B2E",
  "agente-oc13-autonomo": "#1B1A17",
};

// ============================================================
// Data hooks
// ============================================================

function useMetricas() {
  return useQuery({
    queryKey: ["aprendizado", "metricas", JANELA_GRAFICO_DIAS],
    queryFn: async (): Promise<MetricaDiaria[]> => {
      const desde = new Date(Date.now() - JANELA_GRAFICO_DIAS * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      // View agregada dia×agente (~180 linhas/60d) — nunca encosta no teto
      // de 1000 linhas do PostgREST (bug de 21/07: a view granular tinha
      // 1237 linhas e os dias recentes eram cortados silenciosamente).
      const { data, error } = await supabase
        .from("v_sinal_ouro_por_dia_agente")
        .select("*")
        .gte("dia", desde)
        .order("dia", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as MetricaDiaria[];
    },
  });
}

function usePerguntas() {
  return useQuery({
    queryKey: ["aprendizado", "perguntas"],
    queryFn: async (): Promise<PerguntaRow[]> => {
      const { data, error } = await supabase
        .from("learning_log")
        .select("id,titulo,resumo,created_at,detalhes")
        .eq("agente", "agente-aprendizado")
        .eq("tipo", "pergunta")
        .eq("status", "aberto")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as PerguntaRow[];
    },
  });
}

function useRelatorio() {
  return useQuery({
    queryKey: ["aprendizado", "relatorio"],
    queryFn: async (): Promise<RelatorioRow | null> => {
      const { data, error } = await supabase
        .from("learning_log")
        .select("id,titulo,resumo,created_at,detalhes")
        .eq("agente", "agente-aprendizado")
        .eq("tipo", "relatorio_semanal")
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      return ((data ?? [])[0] as RelatorioRow | undefined) ?? null;
    },
  });
}

function useRespostasRecentes() {
  return useQuery({
    queryKey: ["aprendizado", "respostas"],
    queryFn: async (): Promise<RespostaRow[]> => {
      const { data, error } = await supabase
        .from("learning_log")
        .select("id,titulo,resumo")
        .eq("agente", "agente-aprendizado")
        .eq("tipo", "resposta_admin")
        .order("created_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return (data ?? []) as RespostaRow[];
    },
  });
}

function useImpactos() {
  return useQuery({
    queryKey: ["aprendizado", "impactos"],
    queryFn: async (): Promise<Array<{ id: string; resumo: string | null; severidade: string | null }>> => {
      const { data, error } = await supabase
        .from("learning_log")
        .select("id,resumo,severidade")
        .eq("agente", "agente-aprendizado")
        .eq("tipo", "impacto_medido")
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; resumo: string | null; severidade: string | null }>;
    },
  });
}

function useTrocas() {
  return useQuery({
    queryKey: ["aprendizado", "trocas"],
    queryFn: async (): Promise<TrocaRow[]> => {
      const { data, error } = await supabase
        .from("v_sinal_ouro_trocas")
        .select("agent_name,oc_sugerida,oc_executada,casos")
        .not("oc_executada", "is", null)
        .order("casos", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as TrocaRow[];
    },
  });
}

function useNomesOc() {
  return useQuery({
    queryKey: ["aprendizado", "nomes-oc"],
    queryFn: async (): Promise<Record<number, string>> => {
      const { data } = await supabase
        .from("ocorrencias_dicionario")
        .select("codigo,descricao");
      const map: Record<number, string> = {};
      for (const r of data ?? []) map[r.codigo as number] = r.descricao as string;
      return map;
    },
    staleTime: 60 * 60 * 1000,
  });
}

/** Casos de uma troca específica (clicar numa linha de "O que o time faz no lugar"). */
function useCasosTroca(troca: TrocaRow | null) {
  return useQuery({
    queryKey: [
      "aprendizado",
      "casos-troca",
      troca?.agent_name,
      troca?.oc_sugerida,
      troca?.oc_executada,
    ],
    enabled: troca !== null,
    queryFn: async (): Promise<CasoDetalheT[]> => {
      if (!troca) return [];
      let q = supabase
        .from("v_sinal_ouro_casos")
        .select(
          "nf,card_id,decidido_em,oc_card,oc_executada,operador_card,empresa_cliente,motivo_correcao,decisao_ia",
        )
        .eq("agent_name", troca.agent_name)
        .eq("veredito", "corrigida")
        .eq("oc_executada", troca.oc_executada)
        .order("decidido_em", { ascending: false })
        .limit(5);
      q = troca.oc_sugerida === null
        ? q.is("oc_sugerida", null)
        : q.eq("oc_sugerida", troca.oc_sugerida);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((c: Record<string, unknown>) => {
        const dec = (c.decisao_ia ?? {}) as Record<string, unknown>;
        return {
          nf: (c.nf as string) ?? null,
          card_id: c.card_id as string,
          quando: c.decidido_em as string,
          oc_card: (c.oc_card as number) ?? null,
          oc_executada: (c.oc_executada as number) ?? null,
          operador: (c.operador_card as string) ?? null,
          cliente: (c.empresa_cliente as string) ?? null,
          motivo_correcao: (c.motivo_correcao as string) ?? null,
          por_que_ia: {
            observacao: (dec["observacao_orquestrador"] ?? dec["motivo"] ?? null) as
              | string
              | null,
            motivo_extraido: (dec["motivo_extraido"] ?? null) as string | null,
            confianca: (dec["confianca"] ?? null) as number | null,
            foto_classificacao: (dec["foto_classificacao"] ?? null) as string | null,
            ressalva_texto: (dec["ressalva_texto"] ?? null) as string | null,
          },
        };
      });
    },
  });
}

/** Linha do tempo legível do card (lazy — só quando o caso expande). */
function useTimeline(cardId: string | null) {
  return useQuery({
    queryKey: ["aprendizado", "timeline", cardId],
    enabled: cardId !== null,
    queryFn: async (): Promise<EventoTimeline[]> => {
      const { data, error } = await supabase
        .from("v_card_events_legivel")
        .select("id,narrativa,event_type,ator_nome,created_at")
        .eq("card_id", cardId)
        .not("event_type", "in", EVENTOS_RUIDO)
        .order("created_at", { ascending: false })
        .limit(12);
      if (error) throw error;
      return (data ?? []) as EventoTimeline[];
    },
  });
}

/** Custo do agente-chefe (30d) — gestão do próprio orquestrador. */
function useCustoAgenteChefe() {
  return useQuery({
    queryKey: ["aprendizado", "custo-chefe"],
    queryFn: async (): Promise<{ custoUsd: number; chamadas: number }> => {
      const desde = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const { data, error } = await supabase
        .from("anthropic_usage_log")
        .select("estimated_cost_usd")
        .eq("agent_name", "agente-aprendizado")
        .gte("created_at", desde)
        .limit(2000);
      if (error) throw error;
      const rows = data ?? [];
      return {
        custoUsd: rows.reduce(
          (s: number, r: { estimated_cost_usd: number | null }) =>
            s + (r.estimated_cost_usd ?? 0),
          0,
        ),
        chamadas: rows.length,
      };
    },
  });
}

// ============================================================
// Helpers
// ============================================================

/** Sáb/dom fora de TUDO — não há operação do Relacionamento (Caio 2026-07-21). */
function isFimDeSemana(diaIso: string): boolean {
  const dow = new Date(diaIso + "T12:00:00Z").getUTCDay();
  return dow === 0 || dow === 6;
}

function deCada10(pctv: number | null): string {
  if (pctv === null) return "sem dados suficientes";
  return `de cada 10 sugestões, o time seguiu ${Math.round(pctv / 10)}`;
}

function nomeOc(oc: number | null, nomes: Record<number, string> | undefined): string {
  if (oc === null) return "(sem código)";
  const nome = nomes?.[oc];
  return nome ? `${oc} — ${nome}` : String(oc);
}

type AgenteAgregado = {
  agente: string;
  amigavel: string;
  pares: number;
  seguidas: number;
  corrigidas: number;
  abstencoes: number;
  pct: number | null;
};

function agregarPorAgente(rows: MetricaDiaria[], desde: string): AgenteAgregado[] {
  const acc = new Map<string, AgenteAgregado>();
  for (const r of rows) {
    if (r.dia < desde || isFimDeSemana(r.dia)) continue;
    const cur = acc.get(r.agent_name) ?? {
      agente: r.agent_name,
      amigavel: AGENTE_AMIGAVEL[r.agent_name] ?? r.agent_name,
      pares: 0,
      seguidas: 0,
      corrigidas: 0,
      abstencoes: 0,
      pct: null,
    };
    cur.pares += r.pares;
    cur.seguidas += r.seguidas;
    cur.corrigidas += r.corrigidas;
    cur.abstencoes += r.abstencoes;
    acc.set(r.agent_name, cur);
  }
  for (const a of acc.values()) {
    const avaliadas = a.seguidas + a.corrigidas;
    a.pct = avaliadas > 0 ? Math.round((1000 * a.seguidas) / avaliadas) / 10 : null;
  }
  return [...acc.values()].sort((x, y) => y.pares - x.pares);
}

/** Segunda-feira da semana do dia (chave do bucket semanal). */
function inicioSemana(diaIso: string): string {
  const d = new Date(diaIso + "T12:00:00Z");
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}

type PontoSemana = { semana: string; rotulo: string } & Record<string, number | string | null>;

function seriesSemanais(rows: MetricaDiaria[]): {
  pctPorAgente: PontoSemana[];
  volume: Array<{ semana: string; rotulo: string; seguidas: number; corrigidas: number }>;
  agentes: string[];
} {
  const buckets = new Map<string, Map<string, { s: number; c: number }>>();
  const agentesSet = new Set<string>();
  for (const r of rows) {
    if (isFimDeSemana(r.dia)) continue;
    const w = inicioSemana(r.dia);
    agentesSet.add(r.agent_name);
    const porAgente = buckets.get(w) ?? new Map();
    const cur = porAgente.get(r.agent_name) ?? { s: 0, c: 0 };
    cur.s += r.seguidas;
    cur.c += r.corrigidas;
    porAgente.set(r.agent_name, cur);
    buckets.set(w, porAgente);
  }
  const semanas = [...buckets.keys()].sort();
  const agentes = [...agentesSet];
  const pctPorAgente: PontoSemana[] = semanas.map((w) => {
    const ponto: PontoSemana = {
      semana: w,
      rotulo: format(new Date(w + "T12:00:00Z"), "dd/MM"),
    };
    for (const a of agentes) {
      const v = buckets.get(w)?.get(a);
      const avaliadas = (v?.s ?? 0) + (v?.c ?? 0);
      ponto[a] = avaliadas >= 5 ? Math.round((1000 * (v?.s ?? 0)) / avaliadas) / 10 : null;
    }
    return ponto;
  });
  const volume = semanas.map((w) => {
    let s = 0, c = 0;
    for (const v of buckets.get(w)?.values() ?? []) {
      s += v.s;
      c += v.c;
    }
    return {
      semana: w,
      rotulo: format(new Date(w + "T12:00:00Z"), "dd/MM"),
      seguidas: s,
      corrigidas: c,
    };
  });
  return { pctPorAgente, volume, agentes };
}

// ============================================================
// Página
// ============================================================

export default function Aprendizado() {
  const { user, operador, loading } = useAuth();

  const metricas = useMetricas();
  const perguntas = usePerguntas();
  const relatorio = useRelatorio();
  const respostas = useRespostasRecentes();
  const impactos = useImpactos();
  const trocas = useTrocas();
  const nomesOc = useNomesOc();
  const custo = useCustoAgenteChefe();

  const desde30 = useMemo(
    () =>
      new Date(Date.now() - JANELA_PLACAR_DIAS * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10),
    [],
  );
  const porAgente = useMemo(
    () => agregarPorAgente(metricas.data ?? [], desde30),
    [metricas.data, desde30],
  );
  const graficos = useMemo(() => seriesSemanais(metricas.data ?? []), [metricas.data]);
  const totais = useMemo(() => {
    const seguidas = porAgente.reduce((s, a) => s + a.seguidas, 0);
    const corrigidas = porAgente.reduce((s, a) => s + a.corrigidas, 0);
    const pares = porAgente.reduce((s, a) => s + a.pares, 0);
    const avaliadas = seguidas + corrigidas;
    return {
      pares,
      seguidas,
      corrigidas,
      pct: avaliadas > 0 ? Math.round((1000 * seguidas) / avaliadas) / 10 : null,
    };
  }, [porAgente]);

  if (loading) return null;
  const autorizado =
    operador?.papel === "gestor" &&
    ALLOWLIST_EMAILS.includes((user?.email ?? "").toLowerCase());
  if (!autorizado) return <Navigate to="/inbox" replace />;

  return (
    <div className="mx-auto max-w-4xl px-6 pb-24 pt-8">
      {/* ===== Cabeçalho ===== */}
      <header className="mb-10">
        <div className="flex items-center gap-2 text-ai">
          <Sparkle className="h-4 w-4 fill-current" aria-hidden />
          <span className="font-mono text-[11px] uppercase tracking-[0.18em]">
            Loop de aprendizado
          </span>
        </div>
        <h1 className="mt-2 font-display text-[28px] font-semibold leading-tight text-ink">
          O que a IA aprendeu com o time
        </h1>
        <p className="mt-1 max-w-xl text-[14px] leading-relaxed text-ink-soft">
          Toda vez que alguém segue ou corrige uma sugestão, vira aprendizado.
          Aqui você acompanha os números, responde as perguntas do agente-chefe
          e aprova as melhorias — últimos {JANELA_PLACAR_DIAS} dias.
        </p>
      </header>

      {/* ===== A META (primeira coisa da página) ===== */}
      <MetaHero
        sugeridas={totais.pares}
        seguidas={totais.seguidas}
        corrigidas={totais.corrigidas}
        pct={totais.pct}
        carregando={metricas.isLoading}
      />

      {/* ===== Performance dos agentes (dia a dia) ===== */}
      <PerformanceDiaria
        metricas={metricas.data ?? []}
        carregando={metricas.isLoading}
      />

      {/* ===== Placar-resumo ===== */}
      <section
        aria-label="Resumo"
        className="mb-12 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border-strong bg-border-strong sm:grid-cols-4"
      >
        <StatTile
          rotulo="Sugestões seguidas"
          valor={totais.pct !== null ? `${totais.pct}%` : "—"}
          legenda={deCada10(totais.pct)}
          carregando={metricas.isLoading}
        />
        <StatTile
          rotulo="Decisões avaliadas"
          valor={String(totais.seguidas + totais.corrigidas)}
          legenda={`${totais.pares} pares no total`}
          carregando={metricas.isLoading}
        />
        <StatTile
          rotulo="Correções do time"
          valor={String(totais.corrigidas)}
          legenda="cada uma vira aprendizado"
          carregando={metricas.isLoading}
        />
        <StatTile
          rotulo="Perguntas aguardando"
          valor={String(perguntas.data?.length ?? 0)}
          legenda="respostas destravam melhorias"
          destaque={(perguntas.data?.length ?? 0) > 0}
          carregando={perguntas.isLoading}
        />
      </section>

      {/* ===== Perguntas do agente-chefe ===== */}
      <section aria-label="Perguntas" className="mb-14">
        <TituloSecao
          icone={<MessageCircleQuestion className="h-4 w-4" aria-hidden />}
          titulo="O agente-chefe precisa de você"
          descricao="Cada pergunta nasce de um padrão real, já traz os casos e mostra por que a IA sugeriu o que sugeriu."
        />
        {perguntas.isLoading && <Skeleton alto />}
        {!perguntas.isLoading && (perguntas.data?.length ?? 0) === 0 && (
          <div className="rounded-lg border border-border bg-bg-elevated px-5 py-8 text-center">
            <CheckCircle2 className="mx-auto h-6 w-6 text-positive" aria-hidden />
            <p className="mt-2 text-[14px] font-medium text-ink">
              Nenhuma pergunta aguardando.
            </p>
            <p className="mt-1 text-[13px] text-ink-mute">
              O agente volta a perguntar quando encontrar um padrão novo nos dados.
            </p>
          </div>
        )}
        <div className="space-y-4">
          {(perguntas.data ?? []).map((p, i) => (
            <CartaoPergunta
              key={p.id}
              pergunta={p}
              indice={i + 1}
              nomesOc={nomesOc.data}
            />
          ))}
        </div>
        {(respostas.data?.length ?? 0) > 0 && (
          <details className="group mt-4">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-ink-mute hover:text-ink">
              <ChevronDown
                className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
                aria-hidden
              />
              Respostas já dadas ({respostas.data!.length})
            </summary>
            <ul className="mt-3 space-y-2 border-l-2 border-border pl-4">
              {respostas.data!.map((r) => (
                <li key={r.id} className="text-[13px] leading-relaxed">
                  <span className="text-ink-mute">
                    {r.titulo.replace(/^Resposta: /, "")}
                  </span>
                  <br />
                  <span className="font-medium text-ink">“{r.resumo}”</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* Suas respostas estão ensinando? (medição automática do agente) */}
        {(respostas.data?.length ?? 0) > 0 && (
          <div className="mt-5 rounded-lg border border-border bg-bg-elevated p-4">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
              <Sparkle className="h-3.5 w-3.5 fill-current text-ai" aria-hidden />
              Suas respostas estão ensinando?
            </p>
            {(impactos.data?.length ?? 0) === 0 ? (
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-mute">
                O agente mede automaticamente: ~7 dias depois de cada resposta,
                ele compara quanto o time corrigia aquele padrão antes × depois
                e conta aqui se melhorou, piorou ou ficou estável.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {impactos.data!.map((i) => (
                  <li key={i.id} className="flex items-start gap-2 text-[13px] leading-relaxed">
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                        i.severidade === "warning" ? "bg-warning" : "bg-positive"
                      }`}
                      aria-hidden
                    />
                    <span className="text-ink-soft">{i.resumo}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* ===== Números do aprendizado (dashboards) ===== */}
      <section aria-label="Números" className="mb-14">
        <TituloSecao
          titulo="Números do aprendizado"
          descricao="Evolução semanal de quanto o time segue cada agente, volume avaliado e o custo do próprio agente-chefe."
        />
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-bg-elevated p-5">
            <p className="mb-3 text-[13px] font-medium text-ink">
              Sugestões seguidas por semana{" "}
              <span className="font-normal text-ink-mute">
                (% — semanas com menos de 5 avaliações ficam de fora)
              </span>
            </p>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={graficos.pctPorAgente} margin={{ top: 6, right: 12, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="rotulo"
                    tick={{ fontSize: 11, fill: "var(--c-ink-mute)" }}
                    axisLine={{ stroke: "var(--c-border-strong)" }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fontSize: 11, fill: "var(--c-ink-mute)" }}
                    axisLine={false}
                    tickLine={false}
                    unit="%"
                  />
                  <RechartsTooltip
                    formatter={(v: number, name: string) => [
                      `${v}%`,
                      AGENTE_AMIGAVEL[name] ?? name,
                    ]}
                    labelFormatter={(l) => `Semana de ${l}`}
                    contentStyle={{
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--c-border-strong)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Legend
                    formatter={(v: string) => (
                      <span style={{ color: "var(--c-ink-soft)", fontSize: 12 }}>
                        {AGENTE_AMIGAVEL[v] ?? v}
                      </span>
                    )}
                  />
                  {graficos.agentes.map((a) => (
                    <Line
                      key={a}
                      type="monotone"
                      dataKey={a}
                      stroke={CORES_AGENTE[a] ?? "#8B857A"}
                      strokeWidth={2}
                      dot={{ r: 3, strokeWidth: 0, fill: CORES_AGENTE[a] ?? "#8B857A" }}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-[2fr,1fr]">
            <div className="rounded-lg border border-border bg-bg-elevated p-5">
              <p className="mb-3 text-[13px] font-medium text-ink">
                Volume avaliado por semana{" "}
                <span className="font-normal text-ink-mute">(seguidas × corrigidas)</span>
              </p>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={graficos.volume} margin={{ top: 6, right: 12, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" vertical={false} />
                    <XAxis
                      dataKey="rotulo"
                      tick={{ fontSize: 11, fill: "var(--c-ink-mute)" }}
                      axisLine={{ stroke: "var(--c-border-strong)" }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "var(--c-ink-mute)" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <RechartsTooltip
                      labelFormatter={(l) => `Semana de ${l}`}
                      contentStyle={{
                        background: "var(--bg-elevated)",
                        border: "1px solid var(--c-border-strong)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Legend
                      formatter={(v: string) => (
                        <span style={{ color: "var(--c-ink-soft)", fontSize: 12 }}>
                          {v === "seguidas" ? "Seguidas" : "Corrigidas"}
                        </span>
                      )}
                    />
                    <Bar dataKey="seguidas" stackId="v" fill="#1C7A46" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="corrigidas" stackId="v" fill="#B01420" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="flex flex-col justify-center rounded-lg border border-border bg-bg-elevated p-5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-ink-mute">
                Custo do agente-chefe (30d)
              </p>
              <p className="mt-1.5 font-mono text-[26px] font-semibold tabular-nums text-ink">
                {custo.isLoading
                  ? "…"
                  : `US$ ${(custo.data?.custoUsd ?? 0).toFixed(2)}`}
              </p>
              <p className="mt-1 text-[12px] leading-snug text-ink-soft">
                {custo.data?.chamadas ?? 0} chamadas de IA — o resto do trabalho
                dele é análise direta no banco, sem custo por token.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ===== Relatório da semana ===== */}
      <section aria-label="Relatório da semana" className="mb-14">
        <TituloSecao
          icone={<GraduationCap className="h-4 w-4" aria-hidden />}
          titulo="Relatório da semana"
          descricao={
            relatorio.data
              ? format(
                  new Date(relatorio.data.created_at),
                  "'Gerado' EEEE, d 'de' MMMM 'às' HH:mm",
                  { locale: ptBR },
                )
              : "O agente escreve um resumo toda segunda-feira."
          }
        />
        {relatorio.isLoading && <Skeleton alto />}
        {!relatorio.isLoading && relatorio.data && (
          <article className="rounded-lg border border-border bg-bg-elevated p-6">
            <div className="border-l-2 border-ai pl-4">
              <p className="max-w-[62ch] text-[15px] leading-[1.75] text-ink">
                {relatorio.data.resumo}
              </p>
            </div>
            {(relatorio.data.detalhes?.comparativo?.length ?? 0) > 0 && (
              <table className="mt-6 w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-ink-mute">
                    <th className="pb-2 font-medium">Agente</th>
                    <th className="pb-2 text-right font-medium">Casos</th>
                    <th className="pb-2 text-right font-medium">Seguidas</th>
                    <th className="pb-2 text-right font-medium">vs semana ant.</th>
                  </tr>
                </thead>
                <tbody>
                  {relatorio.data.detalhes!.comparativo!.map((c) => (
                    <tr
                      key={c.agenteAmigavel}
                      className="border-b border-border/60 last:border-0"
                    >
                      <td className="py-2.5 pr-3 text-ink">{c.agenteAmigavel}</td>
                      <td className="py-2.5 text-right font-mono text-ink-soft">
                        {c.paresAtual}
                      </td>
                      <td className="py-2.5 text-right font-mono font-medium text-ink">
                        {c.pctAcertoAtual !== null ? `${c.pctAcertoAtual}%` : "—"}
                      </td>
                      <td className="py-2.5 text-right">
                        <Delta pontos={c.deltaPontos} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
        )}
        {!relatorio.isLoading && !relatorio.data && (
          <p className="text-[13px] text-ink-mute">Nenhum relatório ainda.</p>
        )}
      </section>

      {/* ===== Placar por agente (com "o que ele faz") ===== */}
      <section aria-label="Placar por agente" className="mb-14">
        <TituloSecao
          titulo="Placar por agente"
          descricao="Quanto de cada agente o time segue. Clique no nome pra ver o que exatamente cada um monitora, sugere e lança."
        />
        <div className="overflow-hidden rounded-lg border border-border bg-bg-elevated">
          {metricas.isLoading && <Skeleton />}
          {porAgente.map((a) => (
            <LinhaAgente key={a.agente} agregado={a} />
          ))}
        </div>
      </section>

      {/* ===== Onde mais diverge (trocas clicáveis) ===== */}
      <section aria-label="Onde mais diverge">
        <TituloSecao
          titulo="O que o time faz no lugar"
          descricao="As trocas mais comuns. Clique numa linha pra ver os casos reais — com o porquê da IA e a linha do tempo de cada card."
        />
        <div className="overflow-hidden rounded-lg border border-border bg-bg-elevated">
          {trocas.isLoading && <Skeleton />}
          {(trocas.data ?? []).map((t, i) => (
            <LinhaTroca key={i} troca={t} indice={i + 1} nomesOc={nomesOc.data} />
          ))}
        </div>
      </section>

      <footer className="mt-16 border-t border-border pt-4">
        <p className="text-[12px] leading-relaxed text-ink-mute">
          <Sparkle className="mr-1 inline h-3 w-3 fill-current text-ai" aria-hidden />
          O agente-chefe roda todo dia às 06:30 e fecha a semana no domingo à
          noite. Um vigia independente avisa por e-mail se o loop parar. Nenhuma
          mudança em agente acontece sem aprovação humana.
        </p>
      </footer>
    </div>
  );
}

// ============================================================
// A META — hero do painel: 95% das sugestões seguidas, operador
// tratando só exceção. Número-herói + barra com marcador de meta
// (forma certa pra "progresso contra alvo"; nada de pizza).
// ============================================================

const META_PCT = 95;

function MetaHero(props: {
  sugeridas: number;
  seguidas: number;
  corrigidas: number;
  pct: number | null;
  carregando?: boolean;
}) {
  const { pct } = props;
  const bateu = pct !== null && pct >= META_PCT;
  const gap = pct !== null ? Math.round((META_PCT - pct) * 10) / 10 : null;
  const fmt = (n: number) => n.toLocaleString("pt-BR");

  return (
    <section
      aria-label="Meta de autonomia"
      className="mb-12 overflow-hidden rounded-xl border border-border-strong bg-bg-elevated shadow-[0_1px_0_var(--c-border)]"
    >
      <div className="border-l-[3px] border-signal p-6 sm:p-7">
        {/* rótulo da meta */}
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-mute">
            A meta · sugestões seguidas nos últimos 30 dias
          </p>
          <span className="rounded-full border border-signal/30 bg-signal-soft px-2.5 py-0.5 font-mono text-[11px] font-semibold text-signal-strong">
            meta {META_PCT}%
          </span>
        </div>

        {/* número-herói + leitura em linguagem simples */}
        <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-2">
          <p className="font-mono text-[56px] font-semibold leading-none tabular-nums tracking-tight text-ink sm:text-[68px]">
            {props.carregando ? "…" : pct !== null ? `${pct}%` : "—"}
          </p>
          <div className="pb-2">
            {bateu ? (
              <p className="flex items-center gap-1.5 text-[14px] font-medium text-positive">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                Meta batida — operador tratando só exceção.
              </p>
            ) : (
              <p className="text-[14px] leading-snug text-ink-soft">
                {gap !== null ? (
                  <>
                    Faltam{" "}
                    <span className="font-mono font-semibold text-ink">{gap} pontos</span>{" "}
                    pra IA decidir e o operador validar só a exceção.
                  </>
                ) : (
                  "Ainda sem dados suficientes no período."
                )}
              </p>
            )}
          </div>
        </div>

        {/* barra de progresso com marcador da meta */}
        <div className="relative mt-5 h-2.5 w-full rounded-full bg-bg-muted" aria-hidden>
          {pct !== null && (
            <div
              className={`h-full rounded-full transition-[width] duration-700 ${
                bateu ? "bg-positive" : "bg-ink"
              }`}
              style={{ width: `${Math.min(100, Math.max(1.5, pct))}%` }}
            />
          )}
          <div
            className="absolute -top-1 bottom-[-4px] w-[2px] rounded bg-signal"
            style={{ left: `${META_PCT}%` }}
            title={`meta ${META_PCT}%`}
          />
          <span
            className="absolute top-4 -translate-x-1/2 font-mono text-[10px] font-semibold text-signal-strong"
            style={{ left: `${META_PCT}%` }}
          >
            {META_PCT}%
          </span>
        </div>

        {/* os três números da meta */}
        <div className="mt-9 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
          <div className="bg-bg px-4 py-3.5">
            <p className="text-[11px] font-medium uppercase tracking-wider text-ink-mute">
              Ações sugeridas
            </p>
            <p className="mt-1 font-mono text-[24px] font-semibold leading-none tabular-nums text-ink">
              {props.carregando ? "…" : fmt(props.sugeridas)}
            </p>
            <p className="mt-1 text-[12px] text-ink-soft">tudo que os agentes propuseram</p>
          </div>
          <div className="bg-bg px-4 py-3.5">
            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-mute">
              <span className="h-2 w-2 rounded-full bg-positive" aria-hidden />
              Aprovadas como o agente sugeriu
            </p>
            <p className="mt-1 font-mono text-[24px] font-semibold leading-none tabular-nums text-ink">
              {props.carregando ? "…" : fmt(props.seguidas)}
            </p>
            <p className="mt-1 text-[12px] text-ink-soft">é este número que move a meta</p>
          </div>
          <div className="bg-bg px-4 py-3.5">
            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-mute">
              <span className="h-2 w-2 rounded-full bg-negative" aria-hidden />
              Feitas diferente da sugestão
            </p>
            <p className="mt-1 font-mono text-[24px] font-semibold leading-none tabular-nums text-ink">
              {props.carregando ? "…" : fmt(props.corrigidas)}
            </p>
            <p className="mt-1 text-[12px] text-ink-soft">
              é aqui que atacamos — cada uma vira pergunta e treino
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ============================================================
// PERFORMANCE DOS AGENTES — dia a dia (últimos 7 dias fechados),
// delta contra o dia anterior, filtro por agente.
// ============================================================

type DiaPerformance = {
  dia: string;
  rotuloSemana: string;
  rotuloData: string;
  seguidas: number;
  corrigidas: number;
  avaliadas: number;
  pct: number | null;
  deltaPts: number | null; // vs dia anterior com dados
};

const MIN_AVALIADAS_DIA = 5;

function performanceDiaria(
  rows: MetricaDiaria[],
  agente: string | "todos",
): DiaPerformance[] {
  // Últimos 7 DIAS ÚTEIS fechados (ontem pra trás) — sáb/dom fora:
  // não há operação do Relacionamento no fim de semana.
  const hoje = new Date().toISOString().slice(0, 10);
  const dias: string[] = [];
  for (let i = 1; dias.length < 7 && i <= 14; i++) {
    const dia = new Date(Date.now() - i * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    if (!isFimDeSemana(dia)) dias.unshift(dia);
  }
  const porDia = new Map<string, { s: number; c: number }>();
  for (const r of rows) {
    if (r.dia >= hoje || !dias.includes(r.dia)) continue;
    if (agente !== "todos" && r.agent_name !== agente) continue;
    const cur = porDia.get(r.dia) ?? { s: 0, c: 0 };
    cur.s += r.seguidas;
    cur.c += r.corrigidas;
    porDia.set(r.dia, cur);
  }
  const semana = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  let pctAnterior: number | null = null;
  return dias.map((dia) => {
    const v = porDia.get(dia) ?? { s: 0, c: 0 };
    const avaliadas = v.s + v.c;
    const pct = avaliadas >= MIN_AVALIADAS_DIA
      ? Math.round((1000 * v.s) / avaliadas) / 10
      : null;
    const deltaPts = pct !== null && pctAnterior !== null
      ? Math.round((pct - pctAnterior) * 10) / 10
      : null;
    if (pct !== null) pctAnterior = pct;
    const data = new Date(dia + "T12:00:00Z");
    return {
      dia,
      rotuloSemana: semana[data.getUTCDay()],
      rotuloData: format(data, "dd/MM"),
      seguidas: v.s,
      corrigidas: v.c,
      avaliadas,
      pct,
      deltaPts,
    };
  });
}

function PerformanceDiaria(props: {
  metricas: MetricaDiaria[];
  carregando?: boolean;
}) {
  const [agente, setAgente] = useState<string | "todos">("todos");
  const agentesDisponiveis = useMemo(
    () => [...new Set(props.metricas.map((m) => m.agent_name))].sort(),
    [props.metricas],
  );
  const dias = useMemo(
    () => performanceDiaria(props.metricas, agente),
    [props.metricas, agente],
  );

  return (
    <section aria-label="Performance dos agentes" className="mb-12">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[16px] font-semibold text-ink">
            Performance dos agentes
          </h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-mute">
            Últimos 7 dias úteis, fechados — a seta compara com o dia útil
            anterior. Sáb/dom ficam de fora (sem operação).
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setAgente("todos")}
            className={`rounded-full border px-3 py-1 text-[12px] font-medium transition-colors ${
              agente === "todos"
                ? "border-ink bg-ink text-bg-elevated"
                : "border-border bg-bg-elevated text-ink-soft hover:border-border-strong"
            }`}
          >
            Todos
          </button>
          {agentesDisponiveis.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAgente(a)}
              className={`rounded-full border px-3 py-1 text-[12px] font-medium transition-colors ${
                agente === a
                  ? "border-ink bg-ink text-bg-elevated"
                  : "border-border bg-bg-elevated text-ink-soft hover:border-border-strong"
              }`}
            >
              {AGENTE_AMIGAVEL[a] ?? a}
            </button>
          ))}
        </div>
      </div>

      {props.carregando ? (
        <Skeleton />
      ) : (
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border min-[520px]:grid-cols-7">
          {dias.map((d) => {
            const semDados = d.pct === null;
            return (
              <div
                key={d.dia}
                className={`px-3 py-3.5 text-center ${
                  semDados ? "bg-bg" : "bg-bg-elevated"
                }`}
              >
                <p className="text-[11px] font-medium uppercase tracking-wider text-ink-mute">
                  {d.rotuloSemana}{" "}
                  <span className="font-mono normal-case">{d.rotuloData}</span>
                </p>
                <p
                  className={`mt-1.5 font-mono text-[20px] font-semibold leading-none tabular-nums ${
                    semDados ? "text-ink-disabled" : "text-ink"
                  }`}
                >
                  {semDados ? "—" : `${d.pct}%`}
                </p>
                <div className="mt-1.5 flex min-h-[18px] items-center justify-center">
                  {d.deltaPts !== null && d.deltaPts !== 0 && (
                    <span
                      className={`inline-flex items-center gap-0.5 font-mono text-[11px] font-semibold tabular-nums ${
                        d.deltaPts > 0 ? "text-positive" : "text-negative"
                      }`}
                    >
                      {d.deltaPts > 0 ? (
                        <TrendingUp className="h-3 w-3" aria-hidden />
                      ) : (
                        <TrendingDown className="h-3 w-3" aria-hidden />
                      )}
                      {d.deltaPts > 0 ? "+" : ""}
                      {d.deltaPts}
                    </span>
                  )}
                  {d.deltaPts === 0 && (
                    <span className="font-mono text-[11px] text-ink-mute">=</span>
                  )}
                </div>
                <p className="mt-1 text-[11px] leading-tight text-ink-mute">
                  {semDados
                    ? d.avaliadas > 0
                      ? `só ${d.avaliadas} avaliada${d.avaliadas > 1 ? "s" : ""}`
                      : "sem avaliações"
                    : `${d.seguidas} de ${d.avaliadas} seguidas`}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ============================================================
// Componentes básicos
// ============================================================

function StatTile(props: {
  rotulo: string;
  valor: string;
  legenda: string;
  destaque?: boolean;
  carregando?: boolean;
}) {
  return (
    <div className="bg-bg-elevated px-5 py-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-mute">
        {props.rotulo}
      </p>
      <p
        className={`mt-1.5 font-mono text-[26px] font-semibold leading-none tabular-nums ${
          props.destaque ? "text-ai" : "text-ink"
        }`}
      >
        {props.carregando ? "…" : props.valor}
      </p>
      <p className="mt-1.5 text-[12px] leading-snug text-ink-soft">{props.legenda}</p>
    </div>
  );
}

function TituloSecao(props: {
  titulo: string;
  descricao?: string;
  icone?: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <h2 className="flex items-center gap-2 text-[16px] font-semibold text-ink">
        {props.icone && <span className="text-ai">{props.icone}</span>}
        {props.titulo}
      </h2>
      {props.descricao && (
        <p className="mt-0.5 max-w-xl text-[13px] leading-relaxed text-ink-mute">
          {props.descricao}
        </p>
      )}
    </div>
  );
}

function Delta({ pontos }: { pontos: number | null }) {
  if (pontos === null) {
    return <span className="text-[12px] text-ink-disabled">sem histórico</span>;
  }
  const positivo = pontos > 0;
  const neutro = pontos === 0;
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[13px] tabular-nums ${
        neutro ? "text-ink-mute" : positivo ? "text-positive" : "text-negative"
      }`}
    >
      {!neutro &&
        (positivo ? (
          <TrendingUp className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <TrendingDown className="h-3.5 w-3.5" aria-hidden />
        ))}
      {positivo ? "+" : ""}
      {pontos} pts
    </span>
  );
}

function Medidor({ pct: pctv }: { pct: number | null }) {
  return (
    <div
      className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-bg-muted sm:block"
      aria-hidden
    >
      {pctv !== null && (
        <div
          className="h-full rounded-full bg-ink"
          style={{ width: `${Math.min(100, Math.max(2, pctv))}%` }}
        />
      )}
    </div>
  );
}

function Skeleton({ alto }: { alto?: boolean }) {
  return (
    <div
      className={`animate-pulse rounded-lg border border-border bg-bg-subtle ${
        alto ? "h-36" : "h-20"
      }`}
    />
  );
}

// ============================================================
// Placar: linha de agente com "o que ele faz" dobrado
// ============================================================

function LinhaAgente({ agregado: a }: { agregado: AgenteAgregado }) {
  const [aberto, setAberto] = useState(false);
  const info = AGENTE_INFO[a.agente];
  return (
    <div className="border-b border-border/60 last:border-0">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-bg-subtle/50"
      >
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-[14px] font-medium text-ink">
            {a.amigavel}
            {info && <Info className="h-3.5 w-3.5 shrink-0 text-ink-disabled" aria-hidden />}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-mute">
            {a.seguidas + a.corrigidas} avaliadas · {a.corrigidas} corrigidas
            {a.abstencoes > 0 ? ` · ${a.abstencoes} sem opinião` : ""}
          </p>
        </div>
        <Medidor pct={a.pct} />
        <span className="w-14 text-right font-mono text-[15px] font-semibold tabular-nums text-ink">
          {a.pct !== null ? `${a.pct}%` : "—"}
        </span>
      </button>
      {aberto && info && (
        <dl className="grid gap-2.5 border-t border-border/60 bg-bg-subtle/40 px-5 py-4 text-[13px] leading-relaxed sm:grid-cols-2">
          <div>
            <dt className="font-medium text-ink">O que ele monitora</dt>
            <dd className="mt-0.5 text-ink-soft">{info.monitora}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink">O que ele sugere</dt>
            <dd className="mt-0.5 text-ink-soft">{info.sugere}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink">O que ele lança sozinho</dt>
            <dd className="mt-0.5 text-ink-soft">{info.lanca}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink">Quando roda</dt>
            <dd className="mt-0.5 text-ink-soft">{info.gatilho}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

// ============================================================
// Caso real: por que a IA sugeriu + linha do tempo do card
// ============================================================

function CasoCard({
  caso,
  nomesOc,
}: {
  caso: CasoDetalheT;
  nomesOc: Record<number, string> | undefined;
}) {
  const [aberto, setAberto] = useState(false);
  const timeline = useTimeline(aberto ? caso.card_id : null);
  const pq = caso.por_que_ia;

  return (
    <div className="rounded-md border border-border bg-bg">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-bg-subtle/60"
      >
        <span className="rounded border border-border bg-bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">
          NF {caso.nf ?? "?"}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-soft">
          {caso.cliente ?? ""} · {caso.operador ?? "operador"} lançou{" "}
          <span className="font-medium text-ink">
            {nomeOc(caso.oc_executada, nomesOc)}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ink-disabled">
          {format(new Date(caso.quando), "dd/MM")}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-ink-mute transition-transform ${
            aberto ? "rotate-180" : ""
          }`}
          aria-hidden
        />
      </button>
      {aberto && (
        <div className="space-y-3 border-t border-border px-3.5 py-3">
          <div className="border-l-2 border-ai pl-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-ai">
              ✦ Por que a IA sugeriu
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink">
              {pq.observacao ?? "A IA não registrou observação neste caso."}
            </p>
            <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-mute">
              {pq.foto_classificacao && <span>foto: {pq.foto_classificacao}</span>}
              {pq.ressalva_texto && <span>ressalva: “{pq.ressalva_texto}”</span>}
              {pq.confianca !== null && (
                <span>confiança: {Math.round((pq.confianca ?? 0) * 100)}%</span>
              )}
            </p>
          </div>
          {caso.motivo_correcao && (
            <p className="text-[13px] leading-relaxed text-ink-soft">
              <span className="font-medium text-ink">Motivo registrado pelo time: </span>
              “{caso.motivo_correcao}”
            </p>
          )}
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-ink-mute">
              Linha do tempo do card
            </p>
            {timeline.isLoading && (
              <p className="mt-1 text-[12px] text-ink-mute">carregando…</p>
            )}
            <ul className="mt-1.5 space-y-1.5 border-l border-border pl-3">
              {(timeline.data ?? []).map((e) => (
                <li key={e.id} className="text-[12px] leading-snug">
                  <span className="font-mono text-[11px] text-ink-disabled">
                    {format(new Date(e.created_at), "dd/MM HH:mm")}
                  </span>{" "}
                  <span className="text-ink-soft">
                    {e.narrativa ?? e.event_type}
                  </span>
                </li>
              ))}
              {!timeline.isLoading && (timeline.data?.length ?? 0) === 0 && (
                <li className="text-[12px] text-ink-mute">sem eventos relevantes</li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Troca clicável (seção "O que o time faz no lugar")
// ============================================================

function LinhaTroca({
  troca,
  indice,
  nomesOc,
}: {
  troca: TrocaRow;
  indice: number;
  nomesOc: Record<number, string> | undefined;
}) {
  const [aberta, setAberta] = useState(false);
  const casos = useCasosTroca(aberta ? troca : null);

  return (
    <div className="border-b border-border/60 last:border-0">
      <button
        type="button"
        onClick={() => setAberta((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-bg-subtle/50"
      >
        <span className="w-6 shrink-0 font-mono text-[12px] text-ink-disabled">
          {String(indice).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1 text-[13px] leading-snug">
          <span className="text-ink-mute">
            {AGENTE_AMIGAVEL[troca.agent_name] ?? troca.agent_name} sugeriu{" "}
          </span>
          <span className="font-medium text-ink">
            {nomeOc(troca.oc_sugerida, nomesOc)}
          </span>
          <span className="text-ink-mute"> → time lançou </span>
          <span className="font-medium text-ink">
            {nomeOc(troca.oc_executada, nomesOc)}
          </span>
        </div>
        <span className="shrink-0 font-mono text-[13px] font-medium tabular-nums text-ink-soft">
          {troca.casos}×
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-ink-mute transition-transform ${
            aberta ? "rotate-180" : ""
          }`}
          aria-hidden
        />
      </button>
      {aberta && (
        <div className="space-y-2 border-t border-border/60 bg-bg-subtle/30 px-5 py-3">
          <p className="text-[12px] text-ink-mute">
            Os {Math.min(5, troca.casos)} casos mais recentes desta troca — abra
            cada um pra ver o porquê da IA e a história do card:
          </p>
          {casos.isLoading && <p className="text-[12px] text-ink-mute">carregando…</p>}
          {(casos.data ?? []).map((c) => (
            <CasoCard key={c.card_id + c.quando} caso={c} nomesOc={nomesOc} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Cartão de pergunta — com casos reais embutidos
// ============================================================

function CartaoPergunta({
  pergunta,
  indice,
  nomesOc,
}: {
  pergunta: PerguntaRow;
  indice: number;
  nomesOc: Record<number, string> | undefined;
}) {
  const qc = useQueryClient();
  const [opcaoSel, setOpcaoSel] = useState<OpcaoV2T | null>(null);
  const [followupSel, setFollowupSel] = useState<string[]>([]);
  const [texto, setTexto] = useState("");
  const [arquivos, setArquivos] = useState<File[]>([]);

  const d = pergunta.detalhes ?? {};
  const casos = d.casos_detalhe ?? [];
  // Compat: perguntas antigas só têm rótulos simples
  const opcoesV2: OpcaoV2T[] =
    d.opcoes_v2 ?? (d.opcoes ?? []).map((r) => ({ id: r, rotulo: r }));

  const fu = opcaoSel?.followup;
  const precisaMarcar = (fu?.opcoes.length ?? 0) > 0;
  const precisaTexto = fu !== undefined && fu.opcoes.length === 0;
  const faltaImagem = (fu?.exige_imagem ?? false) && arquivos.length === 0;
  const prontoParaEnviar =
    opcaoSel !== null &&
    (!fu ||
      ((!precisaMarcar || followupSel.length > 0) &&
        (!precisaTexto || texto.trim().length > 3) &&
        !faltaImagem));

  function selecionarOpcao(o: OpcaoV2T) {
    setOpcaoSel((atual) => (atual?.id === o.id ? null : o));
    setFollowupSel([]);
  }

  function toggleFollowup(rotulo: string, multi: boolean | undefined) {
    setFollowupSel((sel) =>
      sel.includes(rotulo)
        ? sel.filter((s) => s !== rotulo)
        : multi
        ? [...sel, rotulo]
        : [rotulo],
    );
  }

  const responder = useMutation({
    mutationFn: async () => {
      if (!opcaoSel) throw new Error("Escolha uma opção");
      // 1. sobe os prints (bucket privado 'aprendizado')
      const paths: string[] = [];
      for (const [i, file] of arquivos.entries()) {
        const nomeLimpo = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
        const path = `respostas/${pergunta.id}/${Date.now()}-${i}-${nomeLimpo}`;
        const { error: upErr } = await supabase.storage
          .from("aprendizado")
          .upload(path, file, { contentType: file.type || "image/png" });
        if (upErr) throw new Error(`upload do print falhou: ${upErr.message}`);
        paths.push(path);
      }
      // 2. registra a cadeia estruturada
      const respostas =
        fu && followupSel.length > 0
          ? [{ pergunta: fu.pergunta, resposta: followupSel.join("; ") }]
          : [];
      const { error } = await supabase.rpc("responder_pergunta_aprendizado", {
        p_pergunta_id: pergunta.id,
        p_opcao: opcaoSel.rotulo,
        p_texto: texto.trim() || null,
        p_respostas: respostas,
        p_imagens: paths,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Resposta registrada — o agente aprende com ela.");
      qc.invalidateQueries({ queryKey: ["aprendizado", "perguntas"] });
      qc.invalidateQueries({ queryKey: ["aprendizado", "respostas"] });
    },
    onError: (e: Error) => toast.error(`Não consegui registrar: ${e.message}`),
  });

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-bg-elevated">
      <div className="border-l-[3px] border-ai p-5">
        <div className="flex items-baseline gap-2.5">
          <span className="font-mono text-[12px] font-semibold text-ai">
            {String(indice).padStart(2, "0")}
          </span>
          <h3 className="text-[15px] font-semibold leading-snug text-ink">
            {pergunta.titulo}
          </h3>
        </div>

        {pergunta.resumo && (
          <p className="mt-2.5 text-[13px] leading-relaxed text-ink-soft">
            <span className="font-medium text-ink">O que aconteceu: </span>
            {pergunta.resumo}
          </p>
        )}

        {/* Casos reais com o porquê da IA — já visíveis, cada um expande */}
        {casos.length > 0 && (
          <div className="mt-3.5">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-mute">
              Os casos mais recentes deste padrão
            </p>
            <div className="space-y-1.5">
              {casos.map((c) => (
                <CasoCard key={c.card_id + c.quando} caso={c} nomesOc={nomesOc} />
              ))}
            </div>
          </div>
        )}

        {d.pergunta && (
          <p className="mt-4 rounded-md bg-bg-subtle px-4 py-3 text-[14px] font-medium leading-relaxed text-ink">
            {d.pergunta}
          </p>
        )}

        <div className="mt-3.5 flex flex-col gap-1.5">
          {opcoesV2.map((op) => {
            const ativa = opcaoSel?.id === op.id;
            return (
              <button
                key={op.id}
                type="button"
                onClick={() => selecionarOpcao(op)}
                className={`rounded-md border px-3.5 py-2.5 text-left text-[13px] leading-snug transition-colors ${
                  ativa
                    ? "border-ink bg-ink text-bg-elevated"
                    : "border-border bg-bg-elevated text-ink hover:border-border-strong hover:bg-bg-subtle"
                }`}
              >
                {op.rotulo}
              </button>
            );
          })}
        </div>

        {/* Pergunta-seguimento: o agente cava o contexto de forma estruturada */}
        {opcaoSel && (
          <div className="mt-3 space-y-3 rounded-md border border-ai/40 bg-ai-soft/30 p-4">
            {fu && (
              <>
                <p className="flex items-start gap-1.5 text-[14px] font-medium leading-relaxed text-ink">
                  <Sparkle className="mt-0.5 h-3.5 w-3.5 shrink-0 fill-current text-ai" aria-hidden />
                  {fu.pergunta}
                </p>
                {fu.opcoes.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {fu.opcoes.map((fo) => {
                      const marcada = followupSel.includes(fo.rotulo);
                      return (
                        <button
                          key={fo.id}
                          type="button"
                          onClick={() => toggleFollowup(fo.rotulo, fu.multi)}
                          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-left text-[13px] leading-snug transition-colors ${
                            marcada
                              ? "border-ai bg-bg-elevated text-ink"
                              : "border-border bg-bg-elevated/70 text-ink-soft hover:border-border-strong"
                          }`}
                        >
                          <span
                            className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm border ${
                              marcada ? "border-ai bg-ai" : "border-border-strong bg-bg-elevated"
                            }`}
                            aria-hidden
                          />
                          {fo.rotulo}
                        </button>
                      );
                    })}
                    {fu.multi && (
                      <p className="text-[11px] text-ink-mute">pode marcar mais de uma</p>
                    )}
                  </div>
                )}
                {(fu.permite_texto || fu.opcoes.length === 0) && (
                  <div>
                    <p className="mb-1 text-[12px] font-medium text-ink-soft">
                      {fu.texto_rotulo ?? "Detalhe em 1-2 frases (dirigido, não é obrigatório):"}
                    </p>
                    <Textarea
                      value={texto}
                      onChange={(e) => setTexto(e.target.value)}
                      className="min-h-[64px] bg-bg-elevated text-[13px]"
                    />
                  </div>
                )}
              </>
            )}

            {/* Prints que comprovam o certo/errado */}
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-ink-soft">
                <Paperclip className="h-3.5 w-3.5" aria-hidden />
                Prints que comprovam
                {fu?.exige_imagem ? (
                  <span className="rounded bg-negative-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-negative">
                    obrigatório
                  </span>
                ) : (
                  <span className="text-ink-mute">(opcional)</span>
                )}
              </p>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(e) =>
                  setArquivos((prev) => [...prev, ...Array.from(e.target.files ?? [])])
                }
                className="block w-full text-[12px] text-ink-soft file:mr-3 file:rounded-md file:border file:border-border file:bg-bg-elevated file:px-3 file:py-1.5 file:text-[12px] file:font-medium file:text-ink hover:file:bg-bg-subtle"
              />
              {arquivos.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {arquivos.map((f, i) => (
                    <li key={i} className="flex items-center gap-2 text-[12px] text-ink-soft">
                      <span className="truncate font-mono">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => setArquivos((prev) => prev.filter((_, j) => j !== i))}
                        className="text-negative hover:underline"
                      >
                        remover
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Button
              onClick={() => responder.mutate()}
              disabled={!prontoParaEnviar || responder.isPending}
              className="w-full sm:w-auto"
            >
              {responder.isPending
                ? "Registrando…"
                : faltaImagem
                ? "Anexe o print pra enviar"
                : precisaMarcar && followupSel.length === 0
                ? "Marque pelo menos uma opção"
                : "Enviar resposta"}
            </Button>
          </div>
        )}

        <details className="group mt-4">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[12px] text-ink-mute hover:text-ink">
            <ChevronDown
              className="h-3 w-3 transition-transform group-open:rotate-180"
              aria-hidden
            />
            Ver detalhes técnicos
          </summary>
          <div className="mt-2 rounded-md bg-bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-ink-soft">
            {Object.entries(d.numeros ?? {}).map(([k, v]) => (
              <div key={k}>
                {k}: {String(v)}
              </div>
            ))}
          </div>
        </details>
      </div>
    </article>
  );
}
