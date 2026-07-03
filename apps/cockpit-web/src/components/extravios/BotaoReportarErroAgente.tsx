import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Flag, X } from "lucide-react";
import { toast } from "sonner";

export function BotaoReportarErroAgente({
  cardId,
  onReported,
  size = "sm",
  rpcName = "reportar_erro_agente_extravio",
  label = "Reportar erro",
}: {
  cardId: string;
  onReported?: () => void;
  size?: "sm" | "xs";
  rpcName?: string;
  label?: string;
}) {
  const [aberto, setAberto] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);

  const enviar = async () => {
    if (!supabase) return;
    setEnviando(true);
    try {
      const { error } = await supabase.rpc(rpcName, {
        p_card_id: cardId,
        p_motivo: motivo.trim() ? motivo.trim() : null,
      });
      if (error) throw error;
      toast.success("Erro reportado. Caio será notificado.");
      setAberto(false);
      setMotivo("");
      onReported?.();
    } catch (e: any) {
      toast.error(e?.message ?? "Falha ao reportar.");
    } finally {
      setEnviando(false);
    }
  };

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setAberto(true);
        }}
        className={cn(
          "inline-flex items-center gap-1 rounded border border-rose-300 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 font-medium hover:bg-rose-100 dark:hover:bg-rose-900/60",
          size === "xs" ? "text-[10px] px-1.5 py-0.5" : "text-[11px] px-2 py-1",
        )}
      >
        <Flag className="h-3 w-3" />
        {label}
      </button>
    );
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="mt-2 rounded border border-rose-300 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 p-2 space-y-2"
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">
          Reportar erro do agente
        </span>
        <button
          type="button"
          onClick={() => {
            setAberto(false);
            setMotivo("");
          }}
          className="text-rose-700 dark:text-rose-300 hover:opacity-70"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <textarea
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder="Motivo (opcional) — o que o agente errou?"
        rows={3}
        className="w-full rounded border border-rose-200 dark:border-rose-900 bg-white dark:bg-zinc-900 px-2 py-1 text-[11px] text-zinc-900 dark:text-zinc-100 outline-none focus:border-rose-400"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setAberto(false);
            setMotivo("");
          }}
          className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-[11px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={enviando}
          onClick={enviar}
          className="rounded border border-rose-500 bg-rose-600 text-white px-2 py-1 text-[11px] font-medium hover:bg-rose-700 disabled:opacity-50"
        >
          {enviando ? "Enviando…" : "Confirmar report"}
        </button>
      </div>
    </div>
  );
}
