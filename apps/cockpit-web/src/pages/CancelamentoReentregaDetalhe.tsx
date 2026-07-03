import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Check, ExternalLink, Zap } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { useState } from "react";

type Status =
  | "pendente"
  | "processado"
  | "precisa_acao"
  | "tratado_manualmente"
  | "cancelado";

interface Row {
  id: number;
  card_id: string;
  nf: string | null;
  ctrc_original: string | null;
  executar_em: string | null;
  processed_at: string | null;
  status: Status;
  cancelado_motivo: string | null;
  operador: string | null;
  responsavel_relacionamento: string | null;
  oc21_lancada_em: string | null;
  ctrc_reentrega_cancelado: string | null;
  subcategoria_falha: string | null;
  sugestao_acao: string | null;
  ultima_falha: string | null;
  tentativas: number | null;
  tratado_em: string | null;
  tratado_por: string | null;
  tratado_motivo: string | null;
  agendado_em: string;
  pagador_cnpj?: string | null;
  pagador_nome?: string | null;
  motivo_cancelamento?: string | null;
}

const SUBCATEGORIA_LABEL: Record<string, string> = {
  ctrc_faturado: "CTRC já foi faturado",
  ctrc_inexistente: "CT-e de reentrega não encontrado",
  ctrc_ja_cancelado: "Já estava cancelado",
  sem_permissao: "Sem permissão SSW",
  fora_prazo: "Fora do prazo",
  tela_inesperada: "SSW respondeu tela inesperada",
  outro: "Erro não categorizado",
};

const AUTOMACOES_POR_SUBCATEGORIA: Record<
  string,
  Array<{ label: string; icon: string; acao: string }>
> = {
  ctrc_faturado: [
    {
      label: "Notificar financeiro (Maisa) — pedir exclusão da fatura",
      icon: "📧",
      acao: "notificar_financeiro_exclusao",
    },
  ],
  ctrc_inexistente: [
    {
      label: "Notificar operação — verificar emissão de reentrega",
      icon: "📧",
      acao: "notificar_operacao_reentrega",
    },
  ],
  sem_permissao: [
    {
      label: "Notificar admin SSW — liberar acesso MTZ",
      icon: "📧",
      acao: "notificar_admin_ssw",
    },
  ],
};

const AUTOMACOES_GENERICAS = [
  { label: "Comentar internamente", icon: "💬", acao: "comentar" },
];

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function StatusLine({ r }: { r: Row }) {
  switch (r.status) {
    case "pendente":
      return <span className="text-ink-soft">⏳ Aguardando cron diário (próxima execução: {fmt(r.executar_em)})</span>;
    case "processado":
      return <span className="text-green-800">✅ Cancelado em {fmt(r.processed_at)}</span>;
    case "precisa_acao": {
      const label = r.subcategoria_falha
        ? (SUBCATEGORIA_LABEL[r.subcategoria_falha] ?? r.subcategoria_falha)
        : "Falha";
      return <span className="text-orange-800">⚠️ {label}</span>;
    }
    case "tratado_manualmente":
      return (
        <span className="text-ink-soft">
          🔕 Tratado em {fmt(r.tratado_em)} por {r.tratado_por ?? "—"}
        </span>
      );
    case "cancelado":
      return <span className="text-ink-soft">⚫ Descartado</span>;
  }
}

export default function CancelamentoReentregaDetalhe() {
  const { acao_id } = useParams<{ acao_id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["cancelamento-reentrega", acao_id],
    enabled: !!acao_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_cancelamentos_reentrega")
        .select("*")
        .eq("id", Number(acao_id))
        .maybeSingle();
      if (error) throw error;
      return data as Row | null;
    },
  });

  async function forcar() {
    if (!data) return;
    setBusy(true);
    try {
      const { data: res, error } = await supabase.functions.invoke("forcar-cancelamento-reentrega", {
        body: { acao_id: data.id },
      });
      if (error) throw error;
      if (res?.ok) toast.success(res.mensagem ?? "Cancelamento forçado");
      else toast.error(res?.error ?? "Erro ao forçar cancelamento");
      await refetch();
      qc.invalidateQueries({ queryKey: ["cancelamentos-reentrega"] });
      qc.invalidateQueries({ queryKey: ["cancelamentos-reentrega-count"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao forçar cancelamento");
    } finally {
      setBusy(false);
    }
  }

  async function marcarTratado() {
    if (!data) return;
    const motivo = window.prompt(
      "Como você tratou essa pendência?\n(ex: 'Maisa excluiu da fatura', 'Conversei com cliente, ele topou pagar')",
    );
    if (!motivo || !motivo.trim()) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("marcar_cancelamento_tratado", {
        p_acao_id: data.id,
        p_motivo: motivo.trim(),
      });
      if (error) throw error;
      toast.success("Marcado como tratado");
      await refetch();
      qc.invalidateQueries({ queryKey: ["cancelamentos-reentrega"] });
      qc.invalidateQueries({ queryKey: ["cancelamentos-reentrega-count"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao marcar tratado");
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) {
    return (
      <div className="p-6 font-mono text-[11px] text-ink-soft">Carregando…</div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full flex-col bg-paper">
        <header className="border-b-2 border-ink px-6 py-4">
          <button
            type="button"
            onClick={() => navigate("/cancelamentos-reentrega")}
            className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink"
          >
            <ArrowLeft className="h-3 w-3" /> Voltar
          </button>
        </header>
        <div className="p-6 font-mono text-[11px] text-ink-soft">
          Cancelamento não encontrado ou sem permissão.
        </div>
      </div>
    );
  }

  const podeForcar = data.status === "pendente" || data.status === "precisa_acao";
  const podeTratar = data.status === "precisa_acao";
  const automacoes = data.subcategoria_falha
    ? (AUTOMACOES_POR_SUBCATEGORIA[data.subcategoria_falha] ?? [])
    : [];

  return (
    <div className="flex h-full flex-col bg-paper">
      <header className="border-b-2 border-ink px-6 py-4">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => navigate("/cancelamentos-reentrega")}
            className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink"
          >
            <ArrowLeft className="h-3 w-3" /> Voltar pra Cancelamentos Reentrega
          </button>
          <Link
            to={`/cards/${data.card_id}`}
            className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink"
          >
            Abrir card original <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
        <h1 className="mt-3 font-display text-xl text-ink">
          Cancelamento de Reentrega — NF {data.nf ?? "—"}
        </h1>
        <div className="mt-1 font-mono text-[11px]">
          <StatusLine r={data} />
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <section className="border border-ink/20 bg-paper">
          <div className="border-b border-ink/20 bg-paper-deep px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-ink-soft">
            Dados do cancelamento
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 p-4 font-mono text-[11px] md:grid-cols-2">
            <div>
              <dt className="text-[9px] uppercase tracking-wider text-ink-soft">CTRC original do card</dt>
              <dd className="text-ink">{data.ctrc_original ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[9px] uppercase tracking-wider text-ink-soft">CTRC de reentrega cancelado</dt>
              <dd className="text-ink">{data.ctrc_reentrega_cancelado ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[9px] uppercase tracking-wider text-ink-soft">Operador responsável</dt>
              <dd className="text-ink">{data.operador ?? data.responsavel_relacionamento ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[9px] uppercase tracking-wider text-ink-soft">Cliente pagador</dt>
              <dd className="text-ink">
                {data.pagador_cnpj ?? "—"}
                {data.pagador_nome ? ` — ${data.pagador_nome}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-[9px] uppercase tracking-wider text-ink-soft">oc=21 lançada em</dt>
              <dd className="text-ink">{fmt(data.oc21_lancada_em)}</dd>
            </div>
            <div>
              <dt className="text-[9px] uppercase tracking-wider text-ink-soft">Agendado em</dt>
              <dd className="text-ink">{fmt(data.agendado_em)}</dd>
            </div>
            {data.processed_at && (
              <div>
                <dt className="text-[9px] uppercase tracking-wider text-ink-soft">Cancelamento gravado em</dt>
                <dd className="text-ink">{fmt(data.processed_at)}</dd>
              </div>
            )}
            {data.motivo_cancelamento && (
              <div className="md:col-span-2">
                <dt className="text-[9px] uppercase tracking-wider text-ink-soft">Motivo</dt>
                <dd className="text-ink">{data.motivo_cancelamento}</dd>
              </div>
            )}
            {data.status === "tratado_manualmente" && (
              <div className="md:col-span-2">
                <dt className="text-[9px] uppercase tracking-wider text-ink-soft">Tratativa manual</dt>
                <dd className="text-ink italic">"{data.tratado_motivo ?? "—"}"</dd>
              </div>
            )}
            {data.status === "cancelado" && data.cancelado_motivo && (
              <div className="md:col-span-2">
                <dt className="text-[9px] uppercase tracking-wider text-ink-soft">Descartado</dt>
                <dd className="text-ink">{data.cancelado_motivo}</dd>
              </div>
            )}
          </dl>
        </section>

        {data.status === "precisa_acao" && (
          <section className="border-2 border-orange-400 bg-orange-50">
            <div className="border-b border-orange-300 bg-orange-100 px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-orange-900">
              Diagnóstico
            </div>
            <div className="space-y-2 p-4 font-mono text-[11px]">
              <div className="font-semibold text-orange-900">
                {data.subcategoria_falha
                  ? (SUBCATEGORIA_LABEL[data.subcategoria_falha] ?? data.subcategoria_falha)
                  : "Falha"}
              </div>
              {data.sugestao_acao && (
                <div className="text-ink">
                  <span className="text-[9px] uppercase tracking-wider text-ink-soft">Sugestão IA: </span>
                  <span className="italic">{data.sugestao_acao}</span>
                </div>
              )}
              {data.ultima_falha && (
                <div className="text-[10px] text-ink-soft">{data.ultima_falha}</div>
              )}
              {data.tentativas != null && (
                <div className="text-[10px] text-ink-soft">Tentativas: {data.tentativas}</div>
              )}
            </div>
          </section>
        )}

        <section className="border border-ink/20 bg-paper">
          <div className="border-b border-ink/20 bg-paper-deep px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-ink-soft">
            Histórico
          </div>
          <ul className="space-y-1 p-4 font-mono text-[11px] text-ink">
            {data.processed_at && (
              <li>
                • {fmt(data.processed_at)} —{" "}
                {data.status === "processado" ? "✅ Cancelado com sucesso" : "Processado"}
              </li>
            )}
            {data.tratado_em && (
              <li>
                • {fmt(data.tratado_em)} — 🔕 Marcado tratado por {data.tratado_por ?? "—"}
              </li>
            )}
            <li>• {fmt(data.agendado_em)} — Agendado pra {fmt(data.executar_em)}</li>
            {data.oc21_lancada_em && (
              <li>• {fmt(data.oc21_lancada_em)} — oc=21 aprovada</li>
            )}
          </ul>
        </section>

        {(data.status === "precisa_acao" || data.status === "pendente") && (
          <section className="border border-ink/20 bg-paper">
            <div className="border-b border-ink/20 bg-paper-deep px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-ink-soft">
              Automações internas (próximas evoluções)
            </div>
            <div className="space-y-1.5 p-4">
              {[...automacoes, ...AUTOMACOES_GENERICAS].map((a) => (
                <button
                  key={a.acao}
                  type="button"
                  onClick={() => toast("Automação ainda não implementada, contate o admin")}
                  className="flex w-full items-center gap-2 border border-dashed border-ink/30 bg-paper px-3 py-2 text-left font-mono text-[11px] text-ink-soft hover:border-ink hover:text-ink"
                >
                  <span>{a.icon}</span>
                  <span className="flex-1">{a.label}</span>
                  <span className="text-[9px] uppercase tracking-wider">(em breve)</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {(podeForcar || podeTratar) && (
          <div className="flex gap-2">
            {podeForcar && (
              <button
                type="button"
                disabled={busy}
                onClick={forcar}
                className={cn(
                  "inline-flex items-center gap-1.5 border-2 border-ink bg-ink px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-paper hover:text-ink disabled:opacity-50",
                )}
              >
                <Zap className="h-3.5 w-3.5" /> Forçar cancelamento agora
              </button>
            )}
            {podeTratar && (
              <button
                type="button"
                disabled={busy}
                onClick={marcarTratado}
                className="inline-flex items-center gap-1.5 border-2 border-ink bg-paper px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-ink hover:text-paper disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" /> Marcar tratado manualmente
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
