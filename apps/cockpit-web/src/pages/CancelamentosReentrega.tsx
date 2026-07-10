import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { RefreshCw, Zap, Check } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
}

type Filtro = "todos" | Status;

const FILTROS: { id: Filtro; label: string }[] = [
  { id: "todos", label: "Todos" },
  { id: "pendente", label: "⏳ Pendente" },
  { id: "processado", label: "✅ Cancelado" },
  { id: "precisa_acao", label: "⚠️ Precisa ação" },
  { id: "tratado_manualmente", label: "🔕 Tratado" },
];

const SUBCATEGORIA_LABEL: Record<string, string> = {
  ctrc_faturado: "CTRC já foi faturado",
  ctrc_inexistente: "CT-e de reentrega não encontrado",
  ctrc_ja_cancelado: "Já estava cancelado",
  sem_permissao: "Sem permissão SSW",
  fora_prazo: "Fora do prazo",
  tela_inesperada: "SSW respondeu tela inesperada",
  outro: "Erro não categorizado",
};

function fmtData(iso: string | null): string {
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

function StatusBadge({ status }: { status: Status }) {
  const cfg: Record<Status, { cls: string; text: string }> = {
    pendente: { cls: "bg-slate-100 text-slate-700 border-slate-300", text: "⏳ Pendente" },
    processado: { cls: "bg-green-100 text-green-800 border-green-300", text: "✅ Cancelado" },
    precisa_acao: { cls: "bg-orange-100 text-orange-800 border-orange-400", text: "⚠️ Precisa ação" },
    tratado_manualmente: { cls: "bg-gray-100 text-gray-700 border-gray-300", text: "🔕 Tratado" },
    cancelado: { cls: "bg-zinc-200 text-zinc-700 border-zinc-400", text: "⚫ Descartado" },
  };
  const c = cfg[status] ?? cfg.pendente;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
        c.cls,
      )}
    >
      {c.text}
    </span>
  );
}

function Details({ r }: { r: Row }) {
  switch (r.status) {
    case "pendente":
      return (
        <span className="text-ink-soft">Agendado p/ {fmtData(r.executar_em)}</span>
      );
    case "processado":
      return (
        <div className="text-ink">
          <div>{r.ctrc_reentrega_cancelado ?? "Cancelado"}</div>
          <div className="text-[10px] text-ink-soft">{fmtData(r.processed_at)}</div>
        </div>
      );
    case "precisa_acao": {
      const label = r.subcategoria_falha
        ? (SUBCATEGORIA_LABEL[r.subcategoria_falha] ?? r.subcategoria_falha)
        : "Falha";
      return (
        <div className="text-ink">
          <div className="font-semibold text-orange-800">{label}</div>
          {r.sugestao_acao && (
            <div className="text-[10px] text-ink-soft italic">"{r.sugestao_acao}"</div>
          )}
        </div>
      );
    }
    case "tratado_manualmente":
      return (
        <div className="text-ink-soft">
          <div className="italic">"{r.tratado_motivo ?? "—"}"</div>
          <div className="text-[10px]">
            {r.tratado_por ?? "—"} · {fmtData(r.tratado_em)}
          </div>
        </div>
      );
    case "cancelado":
      return <span className="text-ink-soft">{r.cancelado_motivo ?? "Descartado"}</span>;
    default:
      return null;
  }
}

export default function CancelamentosReentrega() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [busyId, setBusyId] = useState<number | null>(null);

  const { data, isLoading, refetch, isRefetching, isError, error } = useQuery({
    queryKey: ["cancelamentos-reentrega"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_cancelamentos_reentrega")
        .select("*")
        .order("agendado_em", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    // Polling fallback baixo (1min, só com aba visível via default do RQ);
    // realtime de `cards` invalida assim que algo muda.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  useRealtimeInvalidate("cards", ["cancelamentos-reentrega"]);
  useRealtimeInvalidate("cards", ["cancelamentos-reentrega-count"]);

  const rows = (data ?? []).filter((r) => (filtro === "todos" ? true : r.status === filtro));

  async function forcar(id: number) {
    setBusyId(id);
    try {
      const { data, error } = await supabase.functions.invoke("forcar-cancelamento-reentrega", {
        body: { acao_id: id },
      });
      if (error) throw error;
      if (data?.ok) {
        toast.success(data.mensagem ?? "Cancelamento forçado");
      } else {
        toast.error(data?.error ?? "Erro ao forçar cancelamento");
      }
      await refetch();
      qc.invalidateQueries({ queryKey: ["cancelamentos-reentrega-count"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao forçar cancelamento");
    } finally {
      setBusyId(null);
    }
  }

  async function marcarTratado(id: number) {
    const motivo = window.prompt(
      "Como você tratou essa pendência?\n(ex: 'Maisa excluiu da fatura', 'Conversei com cliente, ele topou pagar')",
    );
    if (!motivo || !motivo.trim()) return;
    setBusyId(id);
    try {
      const { error } = await supabase.rpc("marcar_cancelamento_tratado", {
        p_acao_id: id,
        p_motivo: motivo.trim(),
      });
      if (error) throw error;
      toast.success("Marcado como tratado");
      await refetch();
      qc.invalidateQueries({ queryKey: ["cancelamentos-reentrega-count"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao marcar tratado");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex h-full flex-col bg-paper">
      <header className="border-b-2 border-ink px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-xl text-ink">Cancelamentos Reentrega (auto)</h1>
            <p className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">
              SSW opção 450 · ações agendadas pós oc=21
            </p>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isRefetching}
            className="inline-flex items-center gap-1.5 border-2 border-ink bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", isRefetching && "animate-spin")} />
            Atualizar
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1">
          {FILTROS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFiltro(f.id)}
              className={cn(
                "border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                filtro === f.id
                  ? "border-ink bg-ink text-paper"
                  : "border-ink/30 bg-paper text-ink-soft hover:border-ink hover:text-ink",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-6 font-mono text-[11px] text-ink-soft">Carregando…</div>
        ) : isError ? (
          // Erro NÃO pode virar "nenhum cancelamento". Estado explícito + retry.
          <div className="m-4 flex flex-col items-start gap-2 rounded-md border border-danger/40 bg-danger/5 p-4 font-mono text-[11px]">
            <span className="font-semibold text-danger">Erro ao carregar os cancelamentos.</span>
            <span className="text-ink-soft">
              {(error as Error)?.message ?? "Falha na consulta."} É erro de carga, não ausência de pendências.
            </span>
            <button
              onClick={() => refetch()}
              className="mt-1 rounded border border-danger/40 px-2 py-1 uppercase tracking-wider text-danger hover:bg-danger/10"
            >
              Tentar novamente
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6 font-mono text-[11px] text-ink-soft">
            Nenhum cancelamento {filtro !== "todos" ? `(${filtro})` : ""} encontrado.
          </div>
        ) : (
          <table className="w-full border-collapse font-mono text-[11px]">
            <thead className="sticky top-0 bg-paper-deep">
              <tr className="border-b-2 border-ink text-left">
                <th className="px-3 py-2 text-[9px] uppercase tracking-wider text-ink-soft">NF</th>
                <th className="px-3 py-2 text-[9px] uppercase tracking-wider text-ink-soft">CTRC origem</th>
                <th className="px-3 py-2 text-[9px] uppercase tracking-wider text-ink-soft">Operador</th>
                <th className="px-3 py-2 text-[9px] uppercase tracking-wider text-ink-soft">Status</th>
                <th className="px-3 py-2 text-[9px] uppercase tracking-wider text-ink-soft">Detalhes</th>
                <th className="px-3 py-2 text-right text-[9px] uppercase tracking-wider text-ink-soft">Ação</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const podeForcar = r.status === "pendente" || r.status === "precisa_acao";
                const podeTratar = r.status === "precisa_acao";
                const isBusy = busyId === r.id;
                return (
                  <tr
                    key={r.id}
                    className="border-b border-ink/10 hover:bg-paper-deep"
                  >
                    <td
                      className="cursor-pointer px-3 py-2 text-ink"
                      onClick={() => navigate(`/cancelamentos-reentrega/${r.id}`)}
                    >
                      {r.nf ?? "—"}
                    </td>
                    <td
                      className="cursor-pointer px-3 py-2 text-ink-soft"
                      onClick={() => navigate(`/cancelamentos-reentrega/${r.id}`)}
                    >
                      {r.ctrc_original ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-ink-soft">{r.operador ?? "—"}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                    <td className="px-3 py-2">
                      {r.ultima_falha && r.status === "precisa_acao" ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div><Details r={r} /></div>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-md text-[11px]">
                              {r.ultima_falha}
                              {r.tentativas != null && <div className="mt-1 text-[10px] opacity-70">tentativas: {r.tentativas}</div>}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <Details r={r} />
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        {podeForcar && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => forcar(r.id)}
                            className="inline-flex items-center gap-1 border border-ink bg-paper px-2 py-1 text-[10px] uppercase tracking-wider text-ink hover:bg-ink hover:text-paper disabled:opacity-50"
                          >
                            <Zap className="h-3 w-3" /> Forçar agora
                          </button>
                        )}
                        {podeTratar && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => marcarTratado(r.id)}
                            className="inline-flex items-center gap-1 border border-ink/40 bg-paper px-2 py-1 text-[10px] uppercase tracking-wider text-ink-soft hover:border-ink hover:text-ink disabled:opacity-50"
                          >
                            <Check className="h-3 w-3" /> Marcar tratado
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
