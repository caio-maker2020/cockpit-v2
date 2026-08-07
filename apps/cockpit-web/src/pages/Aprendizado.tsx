import { useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Check,
  ChevronDown,
  CornerDownRight,
  Info,
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
import { useRealtimeTable } from "@/hooks/useRealtimeTable";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DivergenciaMotivoDialog } from "@/components/cards/DivergenciaMotivoDialog";
import type { Divergencia } from "@/lib/divergencia";
import { nasceuDaMinhaResposta, podeReabrir, rotuloRevisao } from "@/lib/melhorias";
import { ChatMarkdown } from "@/components/aprendizado/ChatMarkdown";
import { MelhoriasOrganizadas } from "@/components/aprendizado/MelhoriasOrganizadas";

// ============================================================
// Painel "IA / Aprendizado" — CONVERSA com o agente-chefe.
// Redesign 2026-07-23 (PDF "Redesign do Cockpit: Três Direções"):
// feed de chat na coluna principal + trilho lateral enxuto.
// TODAS as regras/mecânicas anteriores preservadas: gate Caio+Isadora,
// perguntas com seguimento estruturado, prints obrigatórios em casos de
// evidência, fila de melhorias (aprovação gestor), impacto das respostas,
// números completos dobrados em "ver números completos".
// ============================================================

const ALLOWLIST_EMAILS = [
  "caio@salexpress.com.br",
  "isadora.baldoni@salexpress.com.br",
];
const JANELA_PLACAR_DIAS = 30;
const JANELA_GRAFICO_DIAS = 60;
const META_PCT = 95;

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
  agente_alvo?: string | null;
  created_at: string;
  detalhes: {
    pergunta?: string;
    o_que_sugiro?: string;
    opcoes?: string[];
    opcoes_v2?: OpcaoV2T[];
    casos_ancora?: string[];
    casos_detalhe?: CasoDetalheT[];
    numeros?: Record<string, number>;
    chave_padrao?: string;
    detalhe_tecnico?: { trocas?: Array<{ ocExecutada: number | null; casos: number }> };
  } | null;
};

type RelatorioRow = {
  id: string;
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
type MelhoriaRow = {
  id: string;
  titulo: string;
  resumo: string | null;
  prompt_alvo: string | null;
  /** id do operador que respondeu a pergunta que gerou a proposta (aviso anti-eco) */
  autor_resposta_id: string | null;
};
type MelhoriaRevisadaRow = {
  id: string;
  titulo: string;
  status: string;
  revisado_em: string | null;
  revisado_por: string | null;
  revisor_nome: string | null;
};
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
  created_at: string;
};

const AGENTE_AMIGAVEL: Record<string, string> = {
  "agente-sugere-ocs-padrao": "Agente de recusas",
  "interpretador-resposta-cliente": "Leitor de respostas do cliente",
  "agente-oc13-autonomo": "Agente de limitação do cliente",
  "agente-extravio-d4": "Agente de extravios",
  "agente-ressarcimento-relancar-54": "Agente de ressarcimento",
};

const AGENTE_INFO: Record<
  string,
  { monitora: string; sugere: string; lanca: string; gatilho: string }
> = {
  "agente-sugere-ocs-padrao": {
    monitora:
      "Cards que chegam com recusa ou falta na entrega: 10 (recusa total), 11 (problema de endereço), 19 (falta de volumes) e 35 (recusa parcial).",
    sugere:
      "Lê a foto do canhoto/ressalva e monta as opções: notificar o cliente (54 + e-mail), pedir informação à operação (56) ou documentação de ressarcimento (59).",
    lanca: "Nada sozinho — toda ação passa pela aprovação de um operador.",
    gatilho: "Roda a cada 5 minutos sobre os cards novos dessas ocorrências.",
  },
  "interpretador-resposta-cliente": {
    monitora: "Toda resposta de cliente que chega por e-mail num card.",
    sugere:
      "Interpreta o que o cliente escreveu e sugere a próxima ocorrência (21/33/44/54/55/56) com a instrução preenchida.",
    lanca: "Nada sozinho — o operador aprova (ou corrige) a sugestão.",
    gatilho: "Dispara na hora em que a resposta do cliente é capturada.",
  },
  "agente-oc13-autonomo": {
    monitora:
      "Cards de limitação do cliente (13) de clientes autorizados na lista de exceção.",
    sugere:
      "Classifica a foto e decide: notificar (54 + e-mail), pedir informação (56) ou reentrega (21) com cancelamento da anterior.",
    lanca:
      "Pode lançar a 21 + cancelar reentrega SOZINHO quando a foto comprova e o cliente está na lista — senão vira sugestão.",
    gatilho: "Roda a cada 5 minutos sobre os cards de oc 13 elegíveis.",
  },
};

const CORES_AGENTE: Record<string, string> = {
  "interpretador-resposta-cliente": "#3E5C94",
  "agente-sugere-ocs-padrao": "#C05B2E",
  "agente-oc13-autonomo": "#1B1A17",
};

// ============================================================
// Data hooks (inalterados — mesma fonte de verdade)
// ============================================================

function useMetricas() {
  return useQuery({
    queryKey: ["aprendizado", "metricas", JANELA_GRAFICO_DIAS],
    queryFn: async (): Promise<MetricaDiaria[]> => {
      const desde = new Date(Date.now() - JANELA_GRAFICO_DIAS * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
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
        .select("id,titulo,resumo,agente_alvo,created_at,detalhes")
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
        .select("id,resumo,created_at,detalhes")
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
    queryFn: async (): Promise<
      Array<{ id: string; resumo: string | null; severidade: string | null }>
    > => {
      const { data, error } = await supabase
        .from("learning_log")
        .select("id,resumo,severidade")
        .eq("agente", "agente-aprendizado")
        .eq("tipo", "impacto_medido")
        .order("created_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string;
        resumo: string | null;
        severidade: string | null;
      }>;
    },
  });
}

function useMelhorias() {
  return useQuery({
    queryKey: ["aprendizado", "melhorias"],
    queryFn: async (): Promise<MelhoriaRow[]> => {
      const { data, error } = await supabase
        .from("learning_log")
        .select("id,titulo,resumo,prompt_alvo,parent_id")
        .eq("agente", "agente-aprendizado")
        .eq("tipo", "ajuste_sugerido")
        .eq("status", "aberto")
        .order("created_at", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as Array<MelhoriaRow & { parent_id: string | null }>;

      // Autor da resposta que gerou cada proposta (aviso anti-eco: quem
      // respondeu não deve decidir no impulso — incidente 24/07).
      const parentIds = rows.map((r) => r.parent_id).filter(Boolean) as string[];
      const autorPorResposta = new Map<string, string | null>();
      if (parentIds.length > 0) {
        const { data: pais } = await supabase
          .from("learning_log")
          .select("id,revisado_por")
          .in("id", parentIds);
        for (const p of pais ?? []) {
          autorPorResposta.set(p.id as string, (p.revisado_por as string | null) ?? null);
        }
      }
      return rows.map((r) => ({
        ...r,
        autor_resposta_id: r.parent_id
          ? autorPorResposta.get(r.parent_id) ?? null
          : null,
      }));
    },
  });
}

// Trilha do que já foi decidido — o gap que escondeu do Caio as revisões
// da Isadora em 24/07 (a fila só mostrava status='aberto').
function useMelhoriasRevisadas() {
  return useQuery({
    queryKey: ["aprendizado", "melhorias-revisadas"],
    queryFn: async (): Promise<MelhoriaRevisadaRow[]> => {
      const { data, error } = await supabase
        .from("learning_log")
        .select("id,titulo,status,revisado_em,revisado_por")
        .eq("agente", "agente-aprendizado")
        .eq("tipo", "ajuste_sugerido")
        .in("status", ["aprovado", "rejeitado", "aplicado", "revertido"])
        .order("revisado_em", { ascending: false })
        .limit(5);
      if (error) throw error;
      const rows = (data ?? []) as Array<Omit<MelhoriaRevisadaRow, "revisor_nome">>;

      const revisorIds = [...new Set(rows.map((r) => r.revisado_por).filter(Boolean))] as string[];
      const nomes = new Map<string, string>();
      if (revisorIds.length > 0) {
        const { data: ops } = await supabase
          .from("operadores")
          .select("id,nome")
          .in("id", revisorIds);
        for (const o of ops ?? []) nomes.set(o.id as string, o.nome as string);
      }
      return rows.map((r) => ({
        ...r,
        revisor_nome: r.revisado_por ? nomes.get(r.revisado_por) ?? null : null,
      }));
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

function useTimeline(cardId: string | null) {
  return useQuery({
    queryKey: ["aprendizado", "timeline", cardId],
    enabled: cardId !== null,
    queryFn: async (): Promise<EventoTimeline[]> => {
      const { data, error } = await supabase
        .from("v_card_events_legivel")
        .select("id,narrativa,event_type,created_at")
        .eq("card_id", cardId)
        .not("event_type", "in", EVENTOS_RUIDO)
        .order("created_at", { ascending: false })
        .limit(12);
      if (error) throw error;
      return (data ?? []) as EventoTimeline[];
    },
  });
}

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
// Helpers (mesmas regras de antes)
// ============================================================

function nomeOc(oc: number | null, nomes: Record<number, string> | undefined): string {
  if (oc === null) return "(sem código)";
  const nome = nomes?.[oc];
  return nome ? `${oc} · ${nome}` : String(oc);
}

function isFimDeSemana(diaIso: string): boolean {
  const dow = new Date(diaIso + "T12:00:00Z").getUTCDay();
  return dow === 0 || dow === 6;
}

type Totais = { pares: number; seguidas: number; corrigidas: number; pct: number | null };

function totais30(rows: MetricaDiaria[]): Totais {
  const desde = new Date(Date.now() - JANELA_PLACAR_DIAS * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  let pares = 0, seguidas = 0, corrigidas = 0;
  for (const r of rows) {
    if (r.dia < desde || isFimDeSemana(r.dia)) continue;
    pares += r.pares;
    seguidas += r.seguidas;
    corrigidas += r.corrigidas;
  }
  const av = seguidas + corrigidas;
  return {
    pares,
    seguidas,
    corrigidas,
    pct: av > 0 ? Math.round((1000 * seguidas) / av) / 10 : null,
  };
}

/** Dia a dia (últimos 7 dias ÚTEIS fechados) — restaurado 2026-07-23 a pedido
 * do Caio: o indicador diário com setas some da conversa, mas não do topo. */
type DiaPerf = {
  dia: string;
  rotuloSemana: string;
  rotuloData: string;
  seguidas: number;
  avaliadas: number;
  pct: number | null;
  deltaPts: number | null;
};

const MIN_AVALIADAS_DIA = 5;

function performanceDiaria(rows: MetricaDiaria[], agente: string | "todos"): DiaPerf[] {
  const hoje = new Date().toISOString().slice(0, 10);
  const dias: string[] = [];
  for (let i = 1; dias.length < 7 && i <= 14; i++) {
    const dia = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (dia < hoje && !isFimDeSemana(dia)) dias.unshift(dia);
  }
  const porDia = new Map<string, { s: number; c: number }>();
  for (const r of rows) {
    if (!dias.includes(r.dia)) continue;
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
      avaliadas,
      pct,
      deltaPts,
    };
  });
}

/** % seguidas por agente nos últimos 7 dias ÚTEIS + delta vs 7 úteis anteriores */
function performance7u(rows: MetricaDiaria[]): Array<{
  agente: string;
  amigavel: string;
  pct: number | null;
  delta: number | null;
}> {
  const hoje = new Date().toISOString().slice(0, 10);
  const uteis: string[] = [];
  for (let i = 1; uteis.length < 14 && i <= 28; i++) {
    const dia = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (dia < hoje && !isFimDeSemana(dia)) uteis.push(dia);
  }
  const rec = new Set(uteis.slice(0, 7));
  const ant = new Set(uteis.slice(7, 14));
  const acc = new Map<string, { rs: number; rc: number; as_: number; ac: number }>();
  for (const r of rows) {
    const cur = acc.get(r.agent_name) ?? { rs: 0, rc: 0, as_: 0, ac: 0 };
    if (rec.has(r.dia)) {
      cur.rs += r.seguidas;
      cur.rc += r.corrigidas;
    } else if (ant.has(r.dia)) {
      cur.as_ += r.seguidas;
      cur.ac += r.corrigidas;
    }
    acc.set(r.agent_name, cur);
  }
  const pctDe = (s: number, c: number) =>
    s + c >= 5 ? Math.round((1000 * s) / (s + c)) / 10 : null;
  return [...acc.entries()]
    .map(([agente, v]) => {
      const p = pctDe(v.rs, v.rc);
      const pa = pctDe(v.as_, v.ac);
      return {
        agente,
        amigavel: AGENTE_AMIGAVEL[agente] ?? agente,
        pct: p,
        delta: p !== null && pa !== null ? Math.round((p - pa) * 10) / 10 : null,
      };
    })
    .filter((a) => a.pct !== null)
    .sort((x, y) => (y.pct ?? 0) - (x.pct ?? 0));
}

function inicioSemana(diaIso: string): string {
  const d = new Date(diaIso + "T12:00:00Z");
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}

type PontoSemana = { semana: string; rotulo: string } & Record<
  string,
  number | string | null
>;

function seriesSemanais(rows: MetricaDiaria[]): {
  pctPorAgente: PontoSemana[];
  volume: Array<{ rotulo: string; seguidas: number; corrigidas: number }>;
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
      const av = (v?.s ?? 0) + (v?.c ?? 0);
      ponto[a] = av >= 5 ? Math.round((1000 * (v?.s ?? 0)) / av) / 10 : null;
    }
    return ponto;
  });
  const volume = semanas.map((w) => {
    let s = 0, c = 0;
    for (const v of buckets.get(w)?.values() ?? []) {
      s += v.s;
      c += v.c;
    }
    return { rotulo: format(new Date(w + "T12:00:00Z"), "dd/MM"), seguidas: s, corrigidas: c };
  });
  return { pctPorAgente, volume, agentes };
}

/** Pills "IA SUGERIU → TIME LANÇOU" da pergunta (dados que já embarcamos) */
function pillsDaPergunta(
  p: PerguntaRow,
  nomes: Record<number, string> | undefined,
): { sug: string | null; exe: string | null; vezes: number | null } {
  const chave = p.detalhes?.chave_padrao ?? "";
  const m = /sug(\d+|sem)$/.exec(chave);
  const sugOc = m ? (m[1] === "sem" ? null : Number(m[1])) : null;
  const troca = p.detalhes?.detalhe_tecnico?.trocas?.[0] ?? null;
  return {
    sug: sugOc !== null ? nomeOc(sugOc, nomes) : m ? "(sem código)" : null,
    exe: troca && troca.ocExecutada !== null ? nomeOc(troca.ocExecutada, nomes) : null,
    vezes: troca?.casos ?? null,
  };
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
  const melhorias = useMelhorias();
  const trocas = useTrocas();
  const nomesOc = useNomesOc();
  const custo = useCustoAgenteChefe();

  const [demoPopup, setDemoPopup] = useState(false);

  const totais = useMemo(() => totais30(metricas.data ?? []), [metricas.data]);
  const perf7 = useMemo(() => performance7u(metricas.data ?? []), [metricas.data]);
  const graficos = useMemo(() => seriesSemanais(metricas.data ?? []), [metricas.data]);

  if (loading) return null;
  const autorizado =
    operador?.papel === "gestor" &&
    ALLOWLIST_EMAILS.includes((user?.email ?? "").toLowerCase());
  if (!autorizado) return <Navigate to="/inbox" replace />;

  const primeiroNome = (operador?.nome ?? "").split(" ")[0] || "gestora";
  const abertas = perguntas.data ?? [];

  return (
    <div className="mx-auto max-w-6xl px-6 pb-24 pt-8">
      {/* ===== Cabeçalho ===== */}
      <header className="mb-8">
        <div className="flex items-center gap-2 text-ai">
          <Sparkle className="h-4 w-4 fill-current" aria-hidden />
          <span className="font-mono text-[11px] uppercase tracking-[0.22em]">
            Loop de aprendizado
          </span>
        </div>
        <h1 className="mt-2 font-display text-[28px] font-semibold leading-tight text-ink">
          O que a IA aprendeu com o time
        </h1>
        <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-ink-soft">
          Toda vez que alguém segue ou corrige uma sugestão, vira aprendizado.
          Aqui você conversa com o agente-chefe: ele mostra os padrões que
          achou, você explica o porquê, e ele ajusta os outros agentes.
          Últimos {JANELA_PLACAR_DIAS} dias.
        </p>
      </header>

      {/* ===== Performance dia a dia (7 dias úteis) — sempre visível ===== */}
      <PerformanceDiariaStrip metricas={metricas.data ?? []} />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr),300px]">
        {/* ================= COLUNA PRINCIPAL — A CONVERSA ================= */}
        <main className="min-w-0">
          {/* Header do agente */}
          <div className="mb-4 flex items-center justify-between rounded-xl border border-border bg-bg-elevated px-4 py-3">
            <div className="flex items-center gap-3">
              <AvatarChefe />
              <div>
                <p className="text-[14px] font-semibold leading-tight text-ink">
                  Agente-chefe
                </p>
                <p className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                  orquestra os agentes · analisou{" "}
                  {(totais.seguidas + totais.corrigidas).toLocaleString("pt-BR")}{" "}
                  decisões em 30d
                </p>
              </div>
            </div>
            {abertas.length > 0 && (
              <span className="rounded-full bg-signal-soft px-2.5 py-1 font-mono text-[11px] font-semibold text-signal-strong">
                {abertas.length} pergunta{abertas.length > 1 ? "s" : ""} pra você
              </span>
            )}
          </div>

          {/* Resumo da semana — o chamado do agente-chefe, acima de tudo */}
          <ResumoSemana relatorio={relatorio.data ?? null} nome={primeiroNome} />

          {/* Chat fluido com o agente-chefe (Fase 1 — atrás da flag) */}
          <ChatAgenteChefe nome={primeiroNome} />

          <div className="space-y-4">

            {/* Resumo da semana (quando existir) */}
            {/* Melhorias aguardando aprovação — parte da conversa */}
            {(melhorias.data ?? []).map((m) => (
              <MsgMelhoria key={m.id} melhoria={m} />
            ))}

            {/* As perguntas — a primeira aberta é a ativa */}
            {abertas.map((p, i) => (
              <ChatPergunta
                key={p.id}
                pergunta={p}
                indice={i + 1}
                ativa={i === 0}
                nomesOc={nomesOc.data}
              />
            ))}

            {abertas.length > 1 && (
              <p className="pt-1 text-center text-[12px] text-ink-mute">
                Depois desta, {abertas.length - 1 === 1
                  ? "falta 1 pergunta"
                  : `faltam ${abertas.length - 1} perguntas`}
                {abertas[1] ? ` — ${AGENTE_AMIGAVEL[abertas[1].agente_alvo ?? ""] ?? ""}` : ""}.
              </p>
            )}

            {perguntas.isLoading && <Skeleton alto />}
          </div>

          {/* O que já foi feito — organizado por melhoria (Caio 08/08) */}
          <MelhoriasOrganizadas />
        </main>

        {/* ================= TRILHO LATERAL ================= */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          {/* A META compacta */}
          <div className="rounded-xl border border-border-strong bg-bg-elevated p-4">
            <div className="flex items-baseline justify-between">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-mute">
                A meta · seguidas · 30d
              </p>
              <span className="rounded-full border border-signal/30 bg-signal-soft px-2 py-0.5 font-mono text-[10px] font-semibold text-signal-strong">
                meta {META_PCT}%
              </span>
            </div>
            <p className="mt-2 font-mono text-[40px] font-semibold leading-none tabular-nums text-ink">
              {metricas.isLoading ? "…" : totais.pct !== null ? `${totais.pct}%` : "—"}
            </p>
            <div className="relative mt-3 h-2 w-full rounded-full bg-bg-muted" aria-hidden>
              {totais.pct !== null && (
                <div
                  className={`h-full rounded-full ${
                    totais.pct >= META_PCT ? "bg-positive" : "bg-ink"
                  }`}
                  style={{ width: `${Math.min(100, Math.max(2, totais.pct))}%` }}
                />
              )}
              <div
                className="absolute -top-0.5 bottom-[-2px] w-[2px] rounded bg-signal"
                style={{ left: `${META_PCT}%` }}
              />
            </div>
            <p className="mt-2 text-[12px] leading-snug text-ink-soft">
              {totais.pct !== null && totais.pct < META_PCT
                ? `Faltam ${(Math.round((META_PCT - totais.pct) * 10) / 10)} pontos pra IA decidir e o operador validar só a exceção.`
                : totais.pct !== null
                ? "Meta batida — operador tratando só exceção."
                : "Sem dados suficientes."}
            </p>
            <dl className="mt-3 space-y-1.5 border-t border-border pt-3 text-[12px]">
              <LinhaNumero rotulo="Ações sugeridas" valor={totais.pares} />
              <LinhaNumero
                rotulo="Aprovadas como o agente sugeriu"
                valor={totais.seguidas}
                cor="bg-positive"
              />
              <LinhaNumero
                rotulo="Feitas diferente · vira pergunta"
                valor={totais.corrigidas}
                cor="bg-negative"
              />
            </dl>
          </div>

          {/* Fila de perguntas */}
          <div className="rounded-xl border border-border bg-bg-elevated p-4">
            <p className="text-[13px] font-semibold text-ink">Perguntas do agente-chefe</p>
            <ul className="mt-2 space-y-1.5">
              {(respostas.data ?? []).slice(0, 2).map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-[12px] text-ink-mute">
                  <Check className="h-3.5 w-3.5 shrink-0 text-positive" aria-hidden />
                  <span className="truncate">
                    {r.titulo.replace(/^Resposta: /, "").slice(0, 46)}
                  </span>
                </li>
              ))}
              {abertas.map((p, i) => (
                <li key={p.id} className="flex items-center gap-2 text-[12px]">
                  <span
                    className={`shrink-0 font-mono text-[11px] font-semibold ${
                      i === 0 ? "text-signal" : "text-ink-disabled"
                    }`}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className={`truncate ${i === 0 ? "text-ink" : "text-ink-mute"}`}>
                    {AGENTE_AMIGAVEL[p.agente_alvo ?? ""] ?? p.agente_alvo}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-ink-disabled">
                    {i === 0 ? "agora" : "na fila"}
                  </span>
                </li>
              ))}
              {abertas.length === 0 && (respostas.data?.length ?? 0) === 0 && (
                <li className="text-[12px] text-ink-mute">nada na fila</li>
              )}
            </ul>
          </div>

          {/* Performance compacta */}
          <div className="rounded-xl border border-border bg-bg-elevated p-4">
            <div className="flex items-baseline justify-between">
              <p className="text-[13px] font-semibold text-ink">Performance dos agentes</p>
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                7 dias úteis
              </span>
            </div>
            <ul className="mt-2 space-y-1">
              {perf7.map((a) => (
                <LinhaPerformance key={a.agente} agente={a} />
              ))}
              {perf7.length === 0 && (
                <li className="text-[12px] text-ink-mute">sem dados na janela</li>
              )}
            </ul>
          </div>

          {/* Números completos (dobrado — tudo que existia continua aqui) */}
          <details className="group rounded-xl border border-border bg-bg-elevated">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[13px] font-medium text-ink-soft hover:text-ink">
              Ver números completos
              <ChevronDown
                className="h-4 w-4 transition-transform group-open:rotate-180"
                aria-hidden
              />
            </summary>
            <div className="space-y-4 border-t border-border p-4">
              <NumerosCompletos
                graficos={graficos}
                trocas={trocas.data ?? []}
                nomesOc={nomesOc.data}
                custo={custo.data ?? null}
              />
              <button
                type="button"
                onClick={() => setDemoPopup(true)}
                className="w-full rounded-md border border-dashed border-border-strong px-3 py-2 text-[12px] text-ink-soft hover:bg-bg-subtle"
              >
                Ver o popup que os operadores verão (demonstração)
              </button>
            </div>
          </details>
        </aside>
      </div>

      <footer className="mt-12 border-t border-border pt-4">
        <p className="text-[12px] leading-relaxed text-ink-mute">
          <Sparkle className="mr-1 inline h-3 w-3 fill-current text-ai" aria-hidden />
          Sua resposta vira treino — não vai pro cliente nem pro SSW. O
          agente-chefe roda todo dia às 06:30, fecha a semana no domingo e um
          vigia avisa por e-mail se o loop parar. Nenhuma mudança em agente
          acontece sem aprovação humana.
        </p>
      </footer>

      <DivergenciaMotivoDialog
        aberta={demoPopup}
        div={
          {
            divergente: true,
            acaoKeySugerida: "lancar_ocorrencia:56",
            acaoKeyAprovada: "lancar_oc_e_enviar_email:54",
            ocSugerida: 56,
            ocAprovada: 54,
          } as Divergencia
        }
        onConfirmar={() => {
          setDemoPopup(false);
          toast.info("Demonstração — nada foi registrado.");
        }}
        onCancelar={() => setDemoPopup(false)}
      />
    </div>
  );
}

// ============================================================
// Peças da conversa
// ============================================================

function AvatarChefe({ pequeno }: { pequeno?: boolean }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full bg-signal text-bg-elevated ${
        pequeno ? "h-6 w-6" : "h-8 w-8"
      }`}
      aria-hidden
    >
      <Sparkle className={pequeno ? "h-3 w-3 fill-current" : "h-4 w-4 fill-current"} />
    </span>
  );
}

function MsgAgente({
  children,
  rotulo,
  alerta,
}: {
  children: React.ReactNode;
  rotulo?: string;
  alerta?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <AvatarChefe pequeno />
      <div
        className={`max-w-[92%] rounded-2xl rounded-tl-md border px-4 py-3 ${
          alerta ? "border-warning/40 bg-warning-soft/40" : "border-border bg-bg-elevated"
        }`}
      >
        {rotulo && (
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            {rotulo}
          </p>
        )}
        <div className="text-[13.5px] leading-relaxed text-ink">{children}</div>
      </div>
    </div>
  );
}

// ============================================================
// Botão de anexo destacado + lista de arquivos (mesmos componentes da
// branch do complementar-resposta — duplicados aqui até o merge dela;
// quando as duas branches se encontrarem na master, unificar).
// ============================================================
// Botão de anexo destacado + lista de arquivos (duplicados da branch do
// complementar até o merge dela — unificar quando se encontrarem na master).
// ============================================================

function BotaoAnexar({
  arquivos,
  setArquivos,
  obrigatorio,
  destaque,
  rotulo,
}: {
  arquivos: File[];
  setArquivos: React.Dispatch<React.SetStateAction<File[]>>;
  obrigatorio?: boolean;
  destaque?: boolean;
  rotulo?: string;
}) {
  const temArquivo = arquivos.length > 0;
  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors ${
        temArquivo
          ? "border-positive bg-positive-soft text-ink"
          : obrigatorio
          ? "border-negative bg-negative-soft text-negative hover:bg-negative-soft/70"
          : destaque
          ? "border-ai bg-bg-elevated text-ink hover:bg-ai-soft/40"
          : "border-border-strong bg-bg-elevated text-ink-soft hover:border-ai hover:text-ink"
      }`}
    >
      <Paperclip className="h-3.5 w-3.5" aria-hidden />
      {temArquivo ? `${arquivos.length} print(s) anexado(s)` : rotulo ?? "Anexar print"}
      {obrigatorio && !temArquivo && (
        <span className="rounded bg-negative px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-bg-elevated">
          obrigatório
        </span>
      )}
      <input
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => setArquivos((prev) => [...prev, ...Array.from(e.target.files ?? [])])}
      />
    </label>
  );
}

function ListaArquivos({
  arquivos,
  setArquivos,
}: {
  arquivos: File[];
  setArquivos: React.Dispatch<React.SetStateAction<File[]>>;
}) {
  if (arquivos.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-0.5">
      {arquivos.map((f, i) => (
        <li key={i} className="flex items-center gap-2 text-[11px] text-ink-soft">
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
  );
}

// ============================================================
// Resumo da semana — acima dos chats, escrito como um chamado direto
// à gestão (Caio 08/08: "bem escrito, separado e didático").
// ============================================================

function ResumoSemana({
  relatorio,
  nome,
}: {
  relatorio: { resumo: string; created_at: string } | null;
  nome: string;
}) {
  if (!relatorio?.resumo) return null;
  return (
    <section
      aria-label="Resumo da semana"
      className="mb-5 rounded-xl border border-border bg-bg-elevated p-4"
    >
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
        📊 Resumo da semana · {format(new Date(relatorio.created_at), "dd 'de' MMMM", { locale: ptBR })}
      </p>
      <p className="mt-1.5 text-[14px] font-medium text-ink">
        {nome}, aqui está o filme da semana dos agentes — em 1 minuto de leitura:
      </p>
      <div className="mt-2 max-w-[75ch] border-l-2 border-ai/50 pl-3">
        <ChatMarkdown texto={relatorio.resumo} />
      </div>
      <p className="mt-2.5 text-[12px] text-ink-mute">
        Algo aí te chamou atenção? É só me falar no chat logo abaixo. 👇
      </p>
    </section>
  );
}

// ============================================================
// Chats do agente-chefe (composição Caio 08/08):
//   CHAT 1 — "o agente te chamou": SÓ aparece quando existe pauta aberta
//            (sessão agente_iniciou). Destaque visual — é ele pedindo ajuda.
//   CHAT 2 — "você chama o agente": sempre disponível.
// Atrás da flag aprendizado_chat_enabled (OFF = nada renderiza).
// ============================================================

interface ChatMsgRow {
  id: string;
  papel: "gestor" | "agente" | "sistema";
  conteudo: string;
  imagens: string[] | null;
  created_at: string;
}

interface ChatSessaoRow {
  id: string;
  tipo: string;
  titulo: string | null;
}

function ChatAgenteChefe({ nome }: { nome: string }) {
  const flag = useQuery({
    queryKey: ["aprendizado", "chat-flag"],
    queryFn: async (): Promise<boolean> => {
      const { data } = await supabase
        .from("feature_flags")
        .select("enabled")
        .eq("key", "aprendizado_chat_enabled")
        .maybeSingle();
      return (data as { enabled?: boolean } | null)?.enabled === true;
    },
    staleTime: 60_000,
  });

  const sessoes = useQuery({
    queryKey: ["aprendizado", "chat-sessoes"],
    enabled: flag.data === true,
    queryFn: async (): Promise<ChatSessaoRow[]> => {
      const { data } = await supabase
        .from("aprendizado_chat_sessoes")
        .select("id, tipo, titulo")
        .eq("status", "aberta")
        .order("updated_at", { ascending: false })
        .limit(6);
      return (data ?? []) as ChatSessaoRow[];
    },
  });

  // Pauta nova (06:30) aparece ao vivo, sem refresh
  useRealtimeTable({
    table: "aprendizado_chat_sessoes",
    queryKeys: [["aprendizado", "chat-sessoes"]],
    enabled: flag.data === true,
  });

  if (flag.data !== true) return null;
  const lista = sessoes.data ?? [];
  const pauta = lista.find((x) => x.tipo === "agente_iniciou") ?? null;
  const minha = lista.find((x) => x.tipo === "isadora_iniciou") ?? null;

  return (
    <div className="mb-5 space-y-4">
      {pauta && (
        <ChatThread
          nome={nome}
          sessaoFixa={pauta.id}
          destaque
          titulo={`📋 O agente-chefe te chamou — ${pauta.titulo ?? "pauta do dia"}`}
          subtitulo="ele achou um padrão que precisa da sua visão — responda aqui"
        />
      )}
      <ChatThread
        nome={nome}
        sessaoFixa={minha?.id ?? null}
        permiteNova
        titulo="💬 Fale com o agente-chefe"
        subtitulo="pergunte, investigue, ensine — em linguagem normal"
      />
    </div>
  );
}

function ChatThread({
  nome,
  sessaoFixa,
  titulo,
  subtitulo,
  destaque,
  permiteNova,
}: {
  nome: string;
  sessaoFixa: string | null;
  titulo: string;
  subtitulo: string;
  destaque?: boolean;
  permiteNova?: boolean;
}) {
  const qc = useQueryClient();
  const chaveAberto = `chat-aberto-${destaque ? "pauta" : "livre"}`;
  const [aberto, setAberto] = useState<boolean>(() => {
    try {
      return localStorage.getItem(chaveAberto) === "1";
    } catch {
      return false;
    }
  });
  const alternar = () => {
    setAberto((v) => {
      try {
        localStorage.setItem(chaveAberto, v ? "0" : "1");
      } catch { /* sem storage, sem memória */ }
      return !v;
    });
  };
  const [sessaoLocal, setSessaoLocal] = useState<string | null>(null);
  const [forcarNova, setForcarNova] = useState(false);
  const [texto, setTexto] = useState("");
  const [arquivos, setArquivos] = useState<File[]>([]);
  const sessaoAtiva = forcarNova ? sessaoLocal : sessaoFixa ?? sessaoLocal;

  const mensagens = useQuery({
    queryKey: ["aprendizado", "chat-msgs", sessaoAtiva],
    enabled: !!sessaoAtiva,
    queryFn: async (): Promise<ChatMsgRow[]> => {
      const { data, error } = await supabase
        .from("aprendizado_chat_mensagens")
        .select("id, papel, conteudo, imagens, created_at")
        .eq("sessao_id", sessaoAtiva!)
        .order("created_at", { ascending: true })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as ChatMsgRow[];
    },
  });

  useRealtimeTable({
    table: "aprendizado_chat_mensagens",
    filter: sessaoAtiva ? { column: "sessao_id", value: sessaoAtiva } : undefined,
    queryKeys: [["aprendizado", "chat-msgs", sessaoAtiva]],
    enabled: !!sessaoAtiva,
  });

  const enviar = useMutation({
    mutationFn: async ({ msg, files }: { msg: string; files: File[] }) => {
      const paths: string[] = [];
      for (const [i, file] of files.entries()) {
        const nomeLimpo = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
        const path = `chat/${Date.now()}-${i}-${nomeLimpo}`;
        const { error: upErr } = await supabase.storage
          .from("aprendizado")
          .upload(path, file, { contentType: file.type || "image/png" });
        if (upErr) throw new Error(`upload do print falhou: ${upErr.message}`);
        paths.push(path);
      }
      const { data, error } = await supabase.functions.invoke("agente-chefe-chat", {
        body: { sessao_id: sessaoAtiva, mensagem: msg, imagens: paths },
      });
      if (error) throw new Error(error.message);
      const resp = data as { ok: boolean; sessao_id?: string; error?: string };
      if (!resp?.ok) throw new Error(resp?.error ?? "falha no chat");
      return resp;
    },
    onSuccess: (resp) => {
      if (resp.sessao_id && resp.sessao_id !== sessaoAtiva) setSessaoLocal(resp.sessao_id);
      qc.invalidateQueries({ queryKey: ["aprendizado", "chat-msgs"] });
      qc.invalidateQueries({ queryKey: ["aprendizado", "chat-sessoes"] });
    },
    onError: (e: Error) => toast.error(`O agente-chefe não respondeu: ${e.message}`),
  });

  const podeEnviar = texto.trim().length >= 2 && !enviar.isPending;
  const enviarAgora = () => {
    if (!podeEnviar) return;
    const msg = texto.trim();
    const files = arquivos;
    setTexto("");
    setArquivos([]);
    enviar.mutate({ msg, files });
  };

  return (
    <section
      aria-label={titulo}
      className={`rounded-xl border bg-bg-elevated ${
        destaque ? "border-signal/50 shadow-[0_0_0_1px_rgba(0,0,0,0.02)]" : "border-ai/40"
      }`}
    >
      <button
        type="button"
        onClick={alternar}
        aria-expanded={aberto}
        className={`flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-bg-subtle/50 ${
          aberto ? "border-b border-border" : ""
        } ${destaque && aberto ? "bg-signal-soft/40" : ""}`}
      >
        <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          {titulo}
          {destaque && !aberto && (
            <span className="h-2 w-2 animate-pulse rounded-full bg-signal" aria-label="esperando resposta" />
          )}
          {aberto && <span className="font-normal text-ink-mute">{subtitulo}</span>}
        </span>
        <span className="flex items-center gap-3">
          {aberto && permiteNova && sessaoAtiva && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                setForcarNova(true);
                setSessaoLocal(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.stopPropagation();
                  setForcarNova(true);
                  setSessaoLocal(null);
                }
              }}
              className="text-[11.5px] font-normal text-ink-soft underline-offset-2 hover:underline"
            >
              nova conversa
            </span>
          )}
          <ChevronDown
            className={`h-4 w-4 text-ink-mute transition-transform ${aberto ? "rotate-180" : ""}`}
            aria-hidden
          />
        </span>
      </button>

      {aberto && (mensagens.data ?? []).length > 0 && (
        <div className="max-h-[420px] space-y-3 overflow-y-auto px-4 py-3">
          {(mensagens.data ?? []).map((m) =>
            m.papel === "agente" ? (
              <MsgAgente key={m.id}><ChatMarkdown texto={m.conteudo} /></MsgAgente>
            ) : (
              <MsgVoce key={m.id} nome={nome}>
                {m.conteudo}
                {(m.imagens?.length ?? 0) > 0 && (
                  <span className="mt-1 block text-[11px] opacity-75">
                    📎 {m.imagens!.length} print(s) — o agente analisou a imagem
                  </span>
                )}
              </MsgVoce>
            ),
          )}
          {enviar.isPending && (
            <p className="pl-9 text-[12px] italic text-ink-mute">
              agente-chefe está analisando…
            </p>
          )}
        </div>
      )}
      {aberto && (mensagens.data ?? []).length === 0 && enviar.isPending && (
        <p className="px-4 py-3 text-[12px] italic text-ink-mute">
          agente-chefe está analisando…
        </p>
      )}

      {aberto && (
      <div className="border-t border-border p-3">
        <Textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              enviarAgora();
            }
          }}
          placeholder={destaque
            ? "Responda a pauta do agente aqui…"
            : `Ex.: "como está o agente de recusas?", "me mostra os casos da oc 11", "NF 139908"…`}
          className="min-h-[48px] border-0 bg-transparent px-1 text-[13px] shadow-none focus-visible:ring-0"
        />
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <BotaoAnexar
              arquivos={arquivos}
              setArquivos={setArquivos}
              destaque
              rotulo="anexar print (ele lê a imagem)"
            />
            <span className="hidden text-[10.5px] text-ink-disabled sm:block">
              Enter envia · ~5–10s · ele consulta os dados reais
            </span>
          </div>
          <Button size="sm" onClick={enviarAgora} disabled={!podeEnviar}>
            {enviar.isPending ? "Analisando…" : "Enviar ↑"}
          </Button>
        </div>
        <ListaArquivos arquivos={arquivos} setArquivos={setArquivos} />
      </div>
      )}
    </section>
  );
}

function MsgVoce({ children, nome }: { children: React.ReactNode; nome: string }) {
  return (
    <div className="flex items-start justify-end gap-2.5">
      <div className="max-w-[88%] rounded-2xl rounded-tr-md bg-ink px-4 py-3 text-[13.5px] leading-relaxed text-bg-elevated">
        {children}
      </div>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-muted font-mono text-[10px] font-semibold text-ink-soft">
        {nome.slice(0, 2).toUpperCase()}
      </span>
    </div>
  );
}

function MsgMelhoria({ melhoria }: { melhoria: MelhoriaRow }) {
  const qc = useQueryClient();
  const { operador } = useAuth();
  // Incidente 24/07: rejeição acidental sem confirmação. "Rejeitar" agora é
  // 2 passos; a decisão continua reversível pela trilha (Reabrir).
  const [confirmandoRejeicao, setConfirmandoRejeicao] = useState(false);
  const minhaResposta = nasceuDaMinhaResposta(melhoria.autor_resposta_id, operador?.id);

  const revisar = useMutation({
    mutationFn: async (decisao: "aprovado" | "rejeitado") => {
      const { error } = await supabase.rpc("revisar_learning_log", {
        p_id: melhoria.id,
        p_decisao: decisao,
        p_motivo: decisao === "aprovado"
          ? "Aprovado no painel Aprendizado"
          : "Rejeitado no painel Aprendizado",
      });
      if (error) throw error;
      return decisao;
    },
    onSuccess: (decisao) => {
      toast.success(
        decisao === "aprovado"
          ? "Aprovada — entra na próxima rodada do agente de repositório."
          : "Rejeitada — dá pra reabrir em “já revisadas” se mudar de ideia.",
      );
      qc.invalidateQueries({ queryKey: ["aprendizado", "melhorias"] });
      qc.invalidateQueries({ queryKey: ["aprendizado", "melhorias-revisadas"] });
    },
    onError: (e: Error) => toast.error(`Não consegui registrar: ${e.message}`),
  });

  return (
    <MsgAgente rotulo="proposta de melhoria — aguardando aprovação de um gestor">
      <p className="font-medium">{melhoria.titulo}</p>
      {melhoria.resumo && (
        <p className="mt-1 text-[13px] text-ink-soft">{melhoria.resumo}</p>
      )}
      {melhoria.prompt_alvo && (
        <p className="mt-1.5 font-mono text-[10px] text-ink-mute">
          alvo: {melhoria.prompt_alvo}
        </p>
      )}
      {minhaResposta && (
        <p className="mt-2 rounded-md border border-signal/30 bg-signal-soft px-2.5 py-1.5 text-[12px] text-signal-strong">
          Esta proposta nasceu da <strong>sua</strong> resposta de agora — não
          precisa fazer nada aqui: o ideal é outro gestor revisar.
        </p>
      )}
      {confirmandoRejeicao ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium">
            Rejeitar esta proposta? Ela sai da fila (dá pra reabrir depois).
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => revisar.mutate("rejeitado")}
            disabled={revisar.isPending}
          >
            Sim, rejeitar
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmandoRejeicao(false)}
            disabled={revisar.isPending}
          >
            Cancelar
          </Button>
        </div>
      ) : (
        <div className="mt-2.5 flex gap-2">
          <Button size="sm" onClick={() => revisar.mutate("aprovado")} disabled={revisar.isPending}>
            Aprovar melhoria
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmandoRejeicao(true)}
            disabled={revisar.isPending}
          >
            Rejeitar
          </Button>
        </div>
      )}
    </MsgAgente>
  );
}

// Trilha "já revisadas" — dá visibilidade do que outro gestor decidiu e o
// caminho de undo (Reabrir) que faltou no incidente de 24/07.
function MelhoriasRevisadas({ revisadas }: { revisadas: MelhoriaRevisadaRow[] }) {
  const qc = useQueryClient();
  const { operador } = useAuth();

  const reabrir = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("reabrir_learning_log", {
        p_id: id,
        p_motivo: "Reaberto no painel Aprendizado",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Reaberta — voltou pra fila de aprovação.");
      qc.invalidateQueries({ queryKey: ["aprendizado", "melhorias"] });
      qc.invalidateQueries({ queryKey: ["aprendizado", "melhorias-revisadas"] });
    },
    onError: (e: Error) => toast.error(`Não consegui reabrir: ${e.message}`),
  });

  if (revisadas.length === 0) return null;
  return (
    <details className="ml-9 rounded-xl border border-dashed border-border px-4 py-2.5">
      <summary className="cursor-pointer list-none font-mono text-[10px] uppercase tracking-wider text-ink-mute hover:text-ink">
        propostas já revisadas ({revisadas.length}) — quem decidiu o quê
      </summary>
      <div className="mt-2 space-y-2">
        {revisadas.map((r) => (
          <div key={r.id} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[13px] text-ink-soft">{r.titulo}</p>
              <p className="font-mono text-[10px] text-ink-mute">
                {rotuloRevisao(r.status, r.revisor_nome, r.revisado_por === operador?.id)}
                {r.revisado_em
                  ? ` · ${format(new Date(r.revisado_em), "dd/MM HH:mm", { locale: ptBR })}`
                  : ""}
              </p>
            </div>
            {podeReabrir(r.status) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => reabrir.mutate(r.id)}
                disabled={reabrir.isPending}
              >
                Reabrir
              </Button>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

// ============================================================
// A pergunta como conversa (mecânica ORIGINAL preservada:
// opção → seguimento estruturado → texto dirigido → prints
// obrigatórios em evidência → RPC responder_pergunta_aprendizado)
// ============================================================

function ChatPergunta({
  pergunta,
  indice,
  ativa,
  nomesOc,
}: {
  pergunta: PerguntaRow;
  indice: number;
  ativa: boolean;
  nomesOc: Record<number, string> | undefined;
}) {
  const qc = useQueryClient();
  const [opcaoSel, setOpcaoSel] = useState<OpcaoV2T | null>(null);
  const [followupSel, setFollowupSel] = useState<string[]>([]);
  const [texto, setTexto] = useState("");
  const [arquivos, setArquivos] = useState<File[]>([]);
  const [expandida, setExpandida] = useState(ativa);

  const d = pergunta.detalhes ?? {};
  const casos = d.casos_detalhe ?? [];
  const opcoesV2: OpcaoV2T[] =
    d.opcoes_v2 ?? (d.opcoes ?? []).map((r) => ({ id: r, rotulo: r }));
  const pills = pillsDaPergunta(pergunta, nomesOc);
  const agenteNome = AGENTE_AMIGAVEL[pergunta.agente_alvo ?? ""] ??
    pergunta.agente_alvo ?? "agente";

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

  const responder = useMutation({
    mutationFn: async () => {
      if (!opcaoSel) throw new Error("Escolha uma opção");
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
      const respostas = fu && followupSel.length > 0
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
      qc.invalidateQueries({ queryKey: ["aprendizado", "melhorias"] });
    },
    onError: (e: Error) => toast.error(`Não consegui registrar: ${e.message}`),
  });

  function toggleFollowup(rotulo: string, multi: boolean | undefined) {
    setFollowupSel((sel) =>
      sel.includes(rotulo)
        ? sel.filter((s) => s !== rotulo)
        : multi
        ? [...sel, rotulo]
        : [rotulo],
    );
  }

  // Pergunta na fila (não ativa): preview mínimo, expande no clique
  if (!expandida) {
    return (
      <button
        type="button"
        onClick={() => setExpandida(true)}
        className="ml-9 block w-[92%] rounded-xl border border-dashed border-border px-4 py-2.5 text-left hover:border-border-strong"
      >
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-disabled">
          na fila · pergunta {String(indice).padStart(2, "0")}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-ink-mute">
          {agenteNome}
          {pills.sug ? ` · ${pills.sug} → ${pills.exe ?? "?"}` : ""}
        </span>
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5">
        <AvatarChefe pequeno />
        <div className="max-w-[92%] flex-1 rounded-2xl rounded-tl-md border border-ai/30 bg-bg-elevated px-4 py-3.5">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ai">
            ✦ pergunta {String(indice).padStart(2, "0")} · {agenteNome}
          </p>

          {/* Pills IA SUGERIU → TIME LANÇOU */}
          {pills.sug && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12px]">
              <span className="rounded-md border border-border bg-bg px-2 py-1">
                <span className="mr-1 font-mono text-[9px] uppercase text-ink-mute">
                  IA sugeriu
                </span>
                <span className="font-medium text-ink">{pills.sug}</span>
              </span>
              <span className="text-ink-disabled">→</span>
              <span className="rounded-md border border-signal/30 bg-signal-soft px-2 py-1">
                <span className="mr-1 font-mono text-[9px] uppercase text-signal-strong">
                  time lançou
                </span>
                <span className="font-medium text-ink">{pills.exe ?? "vários caminhos"}</span>
              </span>
              {pills.vezes !== null && (
                <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-ink-soft">
                  {pills.vezes}× em 30d
                </span>
              )}
            </div>
          )}

          {pergunta.resumo && (
            <p className="mt-2.5 text-[13px] leading-relaxed text-ink-soft">
              {pergunta.resumo}
            </p>
          )}
          {d.pergunta && (
            <p className="mt-2 text-[14px] font-medium leading-relaxed text-ink">
              {d.pergunta}
            </p>
          )}

          {/* Casos compactos */}
          {casos.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                os casos mais recentes deste padrão
              </p>
              <div className="space-y-1">
                {casos.map((c) => (
                  <CasoLinha key={c.card_id + c.quando} caso={c} nomesOc={nomesOc} />
                ))}
              </div>
            </div>
          )}

          <details className="group mt-2.5">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-ink-mute hover:text-ink">
              <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" aria-hidden />
              ver detalhes técnicos
            </summary>
            <div className="mt-1.5 rounded-md bg-bg-muted/60 p-2.5 font-mono text-[10px] leading-relaxed text-ink-soft">
              {Object.entries(d.numeros ?? {}).map(([k, v]) => (
                <div key={k}>
                  {k}: {String(v)}
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>

      {/* Sua resposta (nível 1) — bloco didático, identificado */}
      <div className="ml-9 rounded-xl border border-dashed border-border-strong bg-bg-subtle/50 p-3">
        <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-soft">
          <CornerDownRight className="h-3.5 w-3.5 text-ai" aria-hidden />
          Sua resposta — toque numa opção pra responder ao agente
        </p>
        <div className="flex flex-wrap gap-1.5">
          {opcoesV2.map((op) => {
            const ativa2 = opcaoSel?.id === op.id;
            return (
              <button
                key={op.id}
                type="button"
                onClick={() => {
                  setOpcaoSel((atual) => (atual?.id === op.id ? null : op));
                  setFollowupSel([]);
                }}
                className={`rounded-full border px-3 py-1.5 text-[12.5px] leading-snug transition-colors ${
                  ativa2
                    ? "border-ink bg-ink text-bg-elevated"
                    : "border-border bg-bg-elevated text-ink hover:border-border-strong hover:bg-bg-subtle"
                }`}
              >
                {ativa2 ? "✓ " : ""}
                {op.rotulo}
              </button>
            );
          })}
        </div>
        {!opcaoSel && (
          <p className="mt-2 text-[11px] text-ink-mute">
            Depois de escolher, o agente pode fazer mais uma pergunta rápida — e
            aí é só enviar.
          </p>
        )}
      </div>

      {/* Seguimento (nível 2) — o agente cava, estruturado */}
      {opcaoSel && fu && (
        <MsgAgente>
          <p className="font-medium">{fu.pergunta}</p>
          {fu.opcoes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {fu.opcoes.map((fo) => {
                const marcada = followupSel.includes(fo.rotulo);
                return (
                  <button
                    key={fo.id}
                    type="button"
                    onClick={() => toggleFollowup(fo.rotulo, fu.multi)}
                    className={`rounded-full border px-3 py-1.5 text-[12.5px] transition-colors ${
                      marcada
                        ? "border-ai bg-ai-soft text-ink"
                        : "border-border bg-bg text-ink-soft hover:border-border-strong"
                    }`}
                  >
                    {marcada ? "✓ " : ""}
                    {fo.rotulo}
                  </button>
                );
              })}
            </div>
          )}
          {fu.multi && (
            <p className="mt-1 text-[11px] text-ink-mute">pode marcar mais de uma</p>
          )}
        </MsgAgente>
      )}

      {/* Composer */}
      {opcaoSel && (
        <div className="ml-9 rounded-xl border border-border bg-bg-elevated p-3">
          {(fu?.permite_texto || precisaTexto) && (
            <>
              {fu?.texto_rotulo && (
                <p className="mb-1 text-[11.5px] font-medium text-ink-soft">
                  {fu.texto_rotulo}
                </p>
              )}
              <Textarea
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && prontoParaEnviar) {
                    e.preventDefault();
                    responder.mutate();
                  }
                }}
                placeholder="Responder ao agente-chefe…"
                className="min-h-[56px] border-0 bg-transparent px-1 text-[13px] shadow-none focus-visible:ring-0"
              />
            </>
          )}
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-soft hover:text-ink">
              <Paperclip className="h-3.5 w-3.5" aria-hidden />
              {arquivos.length > 0
                ? `${arquivos.length} print(s)`
                : "anexar print"}
              {fu?.exige_imagem && (
                <span className="rounded bg-negative-soft px-1 py-0.5 text-[9px] font-semibold uppercase text-negative">
                  obrigatório
                </span>
              )}
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) =>
                  setArquivos((prev) => [...prev, ...Array.from(e.target.files ?? [])])
                }
              />
            </label>
            <div className="flex items-center gap-3">
              <span className="hidden text-[10.5px] text-ink-disabled sm:block">
                Enter envia · sua resposta vira treino, não vai pro cliente
              </span>
              <Button
                size="sm"
                onClick={() => responder.mutate()}
                disabled={!prontoParaEnviar || responder.isPending}
              >
                {responder.isPending
                  ? "Enviando…"
                  : faltaImagem
                  ? "Anexe o print"
                  : precisaMarcar && followupSel.length === 0
                  ? "Marque uma opção"
                  : "Enviar ↑"}
              </Button>
            </div>
          </div>
          {arquivos.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {arquivos.map((f, i) => (
                <li key={i} className="flex items-center gap-2 text-[11px] text-ink-soft">
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
      )}
    </div>
  );
}

// Linha compacta de caso (expande pro detalhe com o porquê da IA + timeline)
function CasoLinha({
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
    <div className="rounded-md border border-border/70 bg-bg">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-subtle/60"
      >
        <span className="rounded border border-border bg-bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
          NF {caso.nf ?? "?"}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-soft">
          {caso.cliente ?? ""} · <span className="text-ink-mute">{caso.operador ?? "?"} lançou</span>{" "}
          <span className="font-medium text-ink">{nomeOc(caso.oc_executada, nomesOc)}</span>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-ink-disabled">
          {format(new Date(caso.quando), "dd/MM")}
        </span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-ink-mute transition-transform ${aberto ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {aberto && (
        <div className="space-y-2 border-t border-border/70 px-2.5 py-2">
          <div className="border-l-2 border-ai pl-2.5">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ai">
              ✦ por que a IA sugeriu
            </p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink">
              {pq.observacao ?? "A IA não registrou observação neste caso."}
            </p>
            <p className="mt-1 flex flex-wrap gap-x-2.5 text-[10px] text-ink-mute">
              {pq.foto_classificacao && <span>foto: {pq.foto_classificacao}</span>}
              {pq.ressalva_texto && <span>ressalva: “{pq.ressalva_texto}”</span>}
              {pq.confianca !== null && (
                <span>confiança: {Math.round((pq.confianca ?? 0) * 100)}%</span>
              )}
            </p>
          </div>
          {caso.motivo_correcao && (
            <p className="text-[12px] text-ink-soft">
              <span className="font-medium text-ink">Motivo do time: </span>
              “{caso.motivo_correcao}”
            </p>
          )}
          <div>
            <p className="font-mono text-[9px] uppercase tracking-wider text-ink-mute">
              linha do tempo do card
            </p>
            {timeline.isLoading && (
              <p className="text-[11px] text-ink-mute">carregando…</p>
            )}
            <ul className="mt-1 space-y-1 border-l border-border pl-2.5">
              {(timeline.data ?? []).map((e) => (
                <li key={e.id} className="text-[11px] leading-snug">
                  <span className="font-mono text-[10px] text-ink-disabled">
                    {format(new Date(e.created_at), "dd/MM HH:mm")}
                  </span>{" "}
                  <span className="text-ink-soft">{e.narrativa ?? e.event_type}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Faixa dia a dia (7 dias úteis) — o indicador diário do Caio
// ============================================================

function PerformanceDiariaStrip({ metricas }: { metricas: MetricaDiaria[] }) {
  const [agente, setAgente] = useState<string | "todos">("todos");
  const agentesDisponiveis = useMemo(
    () => [...new Set(metricas.map((m) => m.agent_name))].sort(),
    [metricas],
  );
  const dias = useMemo(
    () => performanceDiaria(metricas, agente),
    [metricas, agente],
  );

  return (
    <section aria-label="Performance dia a dia" className="mb-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-mute">
          Performance dos agentes · dia a dia · 7 dias úteis
        </p>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setAgente("todos")}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
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
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
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
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border min-[520px]:grid-cols-7">
        {dias.map((d) => {
          const semDados = d.pct === null;
          return (
            <div
              key={d.dia}
              className={`px-2 py-2.5 text-center ${semDados ? "bg-bg" : "bg-bg-elevated"}`}
            >
              <p className="text-[10px] font-medium uppercase tracking-wider text-ink-mute">
                {d.rotuloSemana}{" "}
                <span className="font-mono normal-case">{d.rotuloData}</span>
              </p>
              <p
                className={`mt-1 font-mono text-[17px] font-semibold leading-none tabular-nums ${
                  semDados ? "text-ink-disabled" : "text-ink"
                }`}
              >
                {semDados ? "—" : `${d.pct}%`}
              </p>
              <div className="mt-0.5 flex min-h-[14px] items-center justify-center">
                {d.deltaPts !== null && d.deltaPts !== 0 && (
                  <span
                    className={`inline-flex items-center gap-0.5 font-mono text-[10px] font-semibold tabular-nums ${
                      d.deltaPts > 0 ? "text-positive" : "text-negative"
                    }`}
                  >
                    {d.deltaPts > 0 ? (
                      <TrendingUp className="h-2.5 w-2.5" aria-hidden />
                    ) : (
                      <TrendingDown className="h-2.5 w-2.5" aria-hidden />
                    )}
                    {d.deltaPts > 0 ? "+" : ""}
                    {d.deltaPts}
                  </span>
                )}
                {d.deltaPts === 0 && (
                  <span className="font-mono text-[10px] text-ink-mute">=</span>
                )}
              </div>
              <p className="mt-0.5 text-[10px] leading-tight text-ink-mute">
                {semDados
                  ? d.avaliadas > 0 ? "poucos dados" : "sem avaliações"
                  : `${d.seguidas}/${d.avaliadas}`}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ============================================================
// Trilho lateral — peças
// ============================================================

function LinhaNumero({
  rotulo,
  valor,
  cor,
}: {
  rotulo: string;
  valor: number;
  cor?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {cor && <span className={`h-1.5 w-1.5 rounded-full ${cor}`} aria-hidden />}
      <dt className="flex-1 text-ink-soft">{rotulo}</dt>
      <dd className="font-mono font-semibold tabular-nums text-ink">
        {valor.toLocaleString("pt-BR")}
      </dd>
    </div>
  );
}

function LinhaPerformance({
  agente,
}: {
  agente: { agente: string; amigavel: string; pct: number | null; delta: number | null };
}) {
  const [aberto, setAberto] = useState(false);
  const info = AGENTE_INFO[agente.agente];
  return (
    <li>
      <button
        type="button"
        onClick={() => info && setAberto((v) => !v)}
        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-[12px] hover:bg-bg-subtle/60"
      >
        <span className="min-w-0 flex-1 truncate text-ink-soft">
          {agente.amigavel}
          {info && <Info className="ml-1 inline h-3 w-3 text-ink-disabled" aria-hidden />}
        </span>
        <span className="font-mono font-semibold tabular-nums text-ink">
          {agente.pct}%
        </span>
        {agente.delta !== null && agente.delta !== 0 && (
          <span
            className={`flex items-center font-mono text-[11px] tabular-nums ${
              agente.delta > 0 ? "text-positive" : "text-negative"
            }`}
          >
            {agente.delta > 0 ? (
              <TrendingUp className="h-3 w-3" aria-hidden />
            ) : (
              <TrendingDown className="h-3 w-3" aria-hidden />
            )}
            {agente.delta > 0 ? "+" : ""}
            {agente.delta}
          </span>
        )}
      </button>
      {aberto && info && (
        <dl className="mb-1 ml-1 space-y-1 border-l-2 border-border pl-2 text-[11px] leading-relaxed">
          <div>
            <dt className="inline font-medium text-ink">Monitora: </dt>
            <dd className="inline text-ink-soft">{info.monitora}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-ink">Sugere: </dt>
            <dd className="inline text-ink-soft">{info.sugere}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-ink">Lança sozinho: </dt>
            <dd className="inline text-ink-soft">{info.lanca}</dd>
          </div>
        </dl>
      )}
    </li>
  );
}

// Tudo que era seção pesada vive aqui, dobrado (nada foi perdido)
function NumerosCompletos({
  graficos,
  trocas,
  nomesOc,
  custo,
}: {
  graficos: ReturnType<typeof seriesSemanais>;
  trocas: TrocaRow[];
  nomesOc: Record<number, string> | undefined;
  custo: { custoUsd: number; chamadas: number } | null;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[12px] font-medium text-ink">
          Seguidas por semana (%)
        </p>
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={graficos.pctPorAgente}
              margin={{ top: 4, right: 8, left: -24, bottom: 0 }}
            >
              <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="rotulo"
                tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }}
                axisLine={{ stroke: "var(--c-border-strong)" }}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }}
                axisLine={false}
                tickLine={false}
              />
              <RechartsTooltip
                formatter={(v: number, name: string) => [`${v}%`, AGENTE_AMIGAVEL[name] ?? name]}
                labelFormatter={(l) => `Semana de ${l}`}
                contentStyle={{
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--c-border-strong)",
                  borderRadius: 8,
                  fontSize: 11,
                }}
              />
              <Legend
                formatter={(v: string) => (
                  <span style={{ color: "var(--c-ink-soft)", fontSize: 10 }}>
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
                  dot={{ r: 2.5, strokeWidth: 0, fill: CORES_AGENTE[a] ?? "#8B857A" }}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-[12px] font-medium text-ink">
          Volume semanal (seguidas × corrigidas)
        </p>
        <div className="h-32">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={graficos.volume} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
              <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="rotulo"
                tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }}
                axisLine={{ stroke: "var(--c-border-strong)" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }}
                axisLine={false}
                tickLine={false}
              />
              <RechartsTooltip
                labelFormatter={(l) => `Semana de ${l}`}
                contentStyle={{
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--c-border-strong)",
                  borderRadius: 8,
                  fontSize: 11,
                }}
              />
              <Bar dataKey="seguidas" stackId="v" fill="#1C7A46" />
              <Bar dataKey="corrigidas" stackId="v" fill="#B01420" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-[12px] font-medium text-ink">O que o time faz no lugar</p>
        <ul className="space-y-1">
          {trocas.slice(0, 6).map((t, i) => (
            <li key={i} className="flex items-center gap-1.5 text-[11px] leading-snug">
              <span className="w-4 shrink-0 font-mono text-[10px] text-ink-disabled">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-soft">
                {AGENTE_AMIGAVEL[t.agent_name] ?? t.agent_name}:{" "}
                {nomeOc(t.oc_sugerida, nomesOc)} → {nomeOc(t.oc_executada, nomesOc)}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-ink-soft">{t.casos}×</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="border-t border-border pt-2 text-[11px] text-ink-mute">
        Custo do agente-chefe (30d):{" "}
        <span className="font-mono font-semibold text-ink">
          US$ {(custo?.custoUsd ?? 0).toFixed(2)}
        </span>{" "}
        · {custo?.chamadas ?? 0} chamadas de IA
      </p>
    </div>
  );
}

function Skeleton({ alto }: { alto?: boolean }) {
  return (
    <div
      className={`animate-pulse rounded-xl border border-border bg-bg-subtle ${
        alto ? "h-32" : "h-16"
      }`}
    />
  );
}

