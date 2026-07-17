import { useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  GraduationCap,
  MessageCircleQuestion,
  Sparkle,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// ============================================================
// Painel "IA / Aprendizado" — Loop de Aprendizado dos agentes.
// Spec: docs/superpowers/specs/2026-07-17-loop-aprendizado-agentes-design.md
//
// Regras da spec §6 (linguagem simples é CONTRATO):
//   - todo item: o que aconteceu / o que eu sugiro / o que preciso que
//     você responda / detalhes dobrados;
//   - números traduzidos ("de cada 10, 8"); oc sempre nome + código;
//   - IA se marca por tratamento (✦ + border-left), não por cor nova.
//
// Fase de teste: visível SÓ pro allowlist abaixo (gestor + e-mail).
// ============================================================

const ALLOWLIST_EMAILS = ["caio@salexpress.com.br"];
const JANELA_DIAS = 30;

// ============================================================
// Types (linhas das views/tabelas — schema mig 299/301)
// ============================================================

type MetricaDiaria = {
  dia: string;
  agent_name: string;
  oc_card: number | null;
  oc_sugerida: number | null;
  operador_card: string | null;
  pares: number;
  seguidas: number;
  corrigidas: number;
  abstencoes: number;
};

type PerguntaRow = {
  id: string;
  titulo: string;
  resumo: string | null;
  created_at: string;
  detalhes: {
    pergunta?: string;
    o_que_sugiro?: string;
    opcoes?: string[];
    casos_ancora?: string[];
    numeros?: Record<string, number>;
    detalhe_tecnico?: unknown;
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

type RespostaRow = {
  id: string;
  titulo: string;
  resumo: string | null;
  revisado_em: string | null;
};

type TrocaRow = {
  agent_name: string;
  oc_sugerida: number | null;
  oc_executada: number | null;
  casos: number;
};

const AGENTE_AMIGAVEL: Record<string, string> = {
  "agente-sugere-ocs-padrao": "Agente de recusas",
  "interpretador-resposta-cliente": "Leitor de respostas do cliente",
  "agente-oc13-autonomo": "Agente de limitação do cliente",
  "agente-extravio-d4": "Agente de extravios",
  "agente-ressarcimento-relancar-54": "Agente de ressarcimento",
};

// ============================================================
// Data hooks
// ============================================================

function useMetricas() {
  return useQuery({
    queryKey: ["aprendizado", "metricas", JANELA_DIAS],
    queryFn: async (): Promise<MetricaDiaria[]> => {
      const desde = new Date(Date.now() - JANELA_DIAS * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      const { data, error } = await supabase
        .from("v_sinal_ouro_metricas_diarias")
        .select("*")
        .gte("dia", desde)
        .limit(5000);
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
        .select("id,titulo,resumo,revisado_em")
        .eq("agente", "agente-aprendizado")
        .eq("tipo", "resposta_admin")
        .order("created_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return (data ?? []) as RespostaRow[];
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

// ============================================================
// Helpers de apresentação (linguagem simples)
// ============================================================

function deCada10(pct: number | null): string {
  if (pct === null) return "sem dados suficientes";
  const n = Math.round(pct / 10);
  return `de cada 10 sugestões, o time seguiu ${n}`;
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

function agregarPorAgente(rows: MetricaDiaria[]): AgenteAgregado[] {
  const acc = new Map<string, AgenteAgregado>();
  for (const r of rows) {
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

// ============================================================
// Página
// ============================================================

export default function Aprendizado() {
  const { user, operador, loading } = useAuth();

  const metricas = useMetricas();
  const perguntas = usePerguntas();
  const relatorio = useRelatorio();
  const respostas = useRespostasRecentes();
  const trocas = useTrocas();
  const nomesOc = useNomesOc();

  const porAgente = useMemo(
    () => agregarPorAgente(metricas.data ?? []),
    [metricas.data],
  );
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
      {/* ===== Cabeçalho editorial ===== */}
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
          e aprova as melhorias — últimos {JANELA_DIAS} dias.
        </p>
      </header>

      {/* ===== Placar-resumo (stat tiles) ===== */}
      <section aria-label="Resumo" className="mb-12 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border-strong bg-border-strong sm:grid-cols-4">
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

      {/* ===== Perguntas do agente-chefe (o coração) ===== */}
      <section aria-label="Perguntas" className="mb-14">
        <TituloSecao
          icone={<MessageCircleQuestion className="h-4 w-4" aria-hidden />}
          titulo="O agente-chefe precisa de você"
          descricao="Perguntas nascem de padrões reais de correção. Cada resposta ensina a IA — e some da fila."
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
            <CartaoPergunta key={p.id} pergunta={p} indice={i + 1} />
          ))}
        </div>
        {(respostas.data?.length ?? 0) > 0 && (
          <details className="group mt-4">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-ink-mute hover:text-ink">
              <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden />
              Respostas já dadas ({respostas.data!.length})
            </summary>
            <ul className="mt-3 space-y-2 border-l-2 border-border pl-4">
              {respostas.data!.map((r) => (
                <li key={r.id} className="text-[13px] leading-relaxed">
                  <span className="text-ink-mute">{r.titulo.replace(/^Resposta: /, "")}</span>
                  <br />
                  <span className="font-medium text-ink">“{r.resumo}”</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* ===== Relatório da semana ===== */}
      <section aria-label="Relatório da semana" className="mb-14">
        <TituloSecao
          icone={<GraduationCap className="h-4 w-4" aria-hidden />}
          titulo="Relatório da semana"
          descricao={
            relatorio.data
              ? format(new Date(relatorio.data.created_at), "'Gerado' EEEE, d 'de' MMMM 'às' HH:mm", { locale: ptBR })
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
                    <tr key={c.agenteAmigavel} className="border-b border-border/60 last:border-0">
                      <td className="py-2.5 pr-3 text-ink">{c.agenteAmigavel}</td>
                      <td className="py-2.5 text-right font-mono text-ink-soft">{c.paresAtual}</td>
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

      {/* ===== Placar por agente ===== */}
      <section aria-label="Placar por agente" className="mb-14">
        <TituloSecao
          titulo="Placar por agente"
          descricao="Quanto de cada agente o time segue. Abstenção (quando a IA prefere não opinar) não conta como erro."
        />
        <div className="overflow-hidden rounded-lg border border-border bg-bg-elevated">
          {metricas.isLoading && <Skeleton />}
          {porAgente.map((a) => (
            <div
              key={a.agente}
              className="flex items-center gap-4 border-b border-border/60 px-5 py-4 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-ink">{a.amigavel}</p>
                <p className="mt-0.5 text-[12px] text-ink-mute">
                  {a.seguidas + a.corrigidas} avaliadas · {a.corrigidas} corrigidas
                  {a.abstencoes > 0 ? ` · ${a.abstencoes} sem opinião` : ""}
                </p>
              </div>
              <Medidor pct={a.pct} />
              <span className="w-14 text-right font-mono text-[15px] font-semibold tabular-nums text-ink">
                {a.pct !== null ? `${a.pct}%` : "—"}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ===== Onde mais diverge ===== */}
      <section aria-label="Onde mais diverge">
        <TituloSecao
          titulo="O que o time faz no lugar"
          descricao="As trocas mais comuns: o que a IA sugeriu e o que foi feito. É daqui que nascem as perguntas."
        />
        <div className="overflow-hidden rounded-lg border border-border bg-bg-elevated">
          {trocas.isLoading && <Skeleton />}
          {(trocas.data ?? []).map((t, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b border-border/60 px-5 py-3 last:border-0"
            >
              <span className="w-6 shrink-0 font-mono text-[12px] text-ink-disabled">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0 flex-1 text-[13px] leading-snug">
                <span className="text-ink-mute">
                  {AGENTE_AMIGAVEL[t.agent_name] ?? t.agent_name} sugeriu{" "}
                </span>
                <span className="font-medium text-ink">
                  {nomeOc(t.oc_sugerida, nomesOc.data)}
                </span>
                <span className="text-ink-mute"> → time lançou </span>
                <span className="font-medium text-ink">
                  {nomeOc(t.oc_executada, nomesOc.data)}
                </span>
              </div>
              <span className="shrink-0 font-mono text-[13px] font-medium tabular-nums text-ink-soft">
                {t.casos}×
              </span>
            </div>
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
// Componentes
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

/** Barra fina de progresso (mark spec dataviz: thin, cantos 4px, trilho sutil). */
function Medidor({ pct }: { pct: number | null }) {
  return (
    <div className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-bg-muted sm:block" aria-hidden>
      {pct !== null && (
        <div
          className="h-full rounded-full bg-ink"
          style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
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
// Cartão de pergunta — o "1 clique" da spec §3
// ============================================================

function CartaoPergunta({ pergunta, indice }: { pergunta: PerguntaRow; indice: number }) {
  const qc = useQueryClient();
  const [opcaoSelecionada, setOpcaoSelecionada] = useState<string | null>(null);
  const [texto, setTexto] = useState("");

  const responder = useMutation({
    mutationFn: async () => {
      if (!opcaoSelecionada) throw new Error("Escolha uma opção");
      const { error } = await supabase.rpc("responder_pergunta_aprendizado", {
        p_pergunta_id: pergunta.id,
        p_opcao: opcaoSelecionada,
        p_texto: texto.trim() || null,
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

  const d = pergunta.detalhes ?? {};
  const numeros = d.numeros ?? {};

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
        {d.o_que_sugiro && (
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
            <span className="font-medium text-ink">Por que importa: </span>
            {d.o_que_sugiro}
          </p>
        )}

        {d.pergunta && (
          <p className="mt-4 rounded-md bg-bg-subtle px-4 py-3 text-[14px] font-medium leading-relaxed text-ink">
            {d.pergunta}
          </p>
        )}

        {/* Opções — 1 clique */}
        <div className="mt-3.5 flex flex-col gap-1.5">
          {(d.opcoes ?? []).map((op) => {
            const ativa = opcaoSelecionada === op;
            return (
              <button
                key={op}
                type="button"
                onClick={() => setOpcaoSelecionada(ativa ? null : op)}
                className={`rounded-md border px-3.5 py-2.5 text-left text-[13px] leading-snug transition-colors ${
                  ativa
                    ? "border-ink bg-ink text-bg-elevated"
                    : "border-border bg-bg-elevated text-ink hover:border-border-strong hover:bg-bg-subtle"
                }`}
              >
                {op}
              </button>
            );
          })}
        </div>

        {opcaoSelecionada && (
          <div className="mt-3 space-y-2.5">
            <Textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Quer detalhar? Quanto mais contexto, melhor a IA aprende. (opcional)"
              className="min-h-[72px] text-[13px]"
            />
            <Button
              onClick={() => responder.mutate()}
              disabled={responder.isPending}
              className="w-full sm:w-auto"
            >
              {responder.isPending ? "Registrando…" : "Enviar resposta"}
            </Button>
          </div>
        )}

        {/* Casos-âncora + detalhes técnicos dobrados */}
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {(d.casos_ancora ?? []).map((nf) => (
            <span
              key={nf}
              className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink-soft"
            >
              NF {nf}
            </span>
          ))}
        </div>
        <details className="group mt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[12px] text-ink-mute hover:text-ink">
            <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" aria-hidden />
            Ver detalhes técnicos
          </summary>
          <div className="mt-2 rounded-md bg-bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-ink-soft">
            {Object.entries(numeros).map(([k, v]) => (
              <div key={k}>
                {k}: {String(v)}
              </div>
            ))}
            <div className="mt-1 flex items-center gap-1 text-ink-mute">
              <CircleAlert className="h-3 w-3" aria-hidden />
              janela dos últimos {JANELA_DIAS} dias
            </div>
          </div>
        </details>
      </div>
    </article>
  );
}
