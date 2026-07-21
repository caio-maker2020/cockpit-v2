import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { useTempoDesdeAcao } from "@/hooks/useTempoDesdeAcao";
import { cn } from "@/lib/utils";
import { ModalLancarEmergencial } from "./ModalLancarEmergencial";

interface Props {
  card: {
    id: string;
    nf: string | null;
    cod_ultima_ocorrencia: number | null;
    acao_executada_em?: string | null;
  };
}

export function AcaoExecutadaPanel({ card }: Props) {
  const tempo = useTempoDesdeAcao(card.acao_executada_em ?? null);
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [modalEmerg, setModalEmerg] = useState(false);

  async function forcar() {
    if (!supabase) return;
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("atualizar-card-via-portal-ssw", {
      body: { card_id: card.id },
    });
    setLoading(false);
    if (error || !data?.ok) {
      toast.error(error?.message ?? data?.error ?? "Erro ao forçar atualização");
      return;
    }
    toast.success("Atualização disparada");
    qc.invalidateQueries({ queryKey: ["card", card.id] });
    qc.invalidateQueries({ queryKey: ["cards"] });
  }

  const sswUrl = card.nf
    ? `https://ssw.inf.br/2/sat?nfe=${encodeURIComponent(card.nf)}`
    : "https://ssw.inf.br/2/";

  return (
    <div className="p-4">
      <div
        className={cn(
          "border-2 px-3 py-3",
          tempo?.bastaoAtrasado ? "border-red-500 bg-red-50" : "border-blue-500 bg-blue-50",
        )}
      >
        <div className="mb-2 flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-wider text-ink">
          <CheckCircle2 className="h-4 w-4 text-good" />
          Ação executada com sucesso
        </div>
        <p className="text-[12px] leading-snug text-ink">
          Você lançou{" "}
          <span className="font-semibold">
            oc {card.cod_ultima_ocorrencia ?? "?"}
          </span>{" "}
          no SSW. Aguardando Bastão sincronizar pra confirmar.
        </p>

        {tempo && (
          <div
            className={cn(
              "mt-2 font-mono text-[11px]",
              tempo.bastaoAtrasado ? "text-red-700 font-bold" : "text-blue-800",
            )}
          >
            ⏱ Tempo desde execução: {tempo.label}
          </div>
        )}

        {tempo?.bastaoAtrasado && (
          <div className="mt-2 border-l-2 border-red-500 bg-red-100 px-2 py-1.5 text-[11px] leading-snug text-red-900">
            ⚠ Após 1h sem confirmação, o Bastão pode estar atrasado. Olha o SSW
            manualmente se quiser.
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={sswUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 border border-ink/30 bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:border-ink"
          >
            <ExternalLink className="h-3 w-3" />
            Ver histórico SSW
          </a>
          <button
            onClick={forcar}
            disabled={loading}
            className="inline-flex items-center gap-1 border border-ink/30 bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink hover:border-ink disabled:opacity-40"
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            Forçar atualização
          </button>
        </div>
      </div>

      <p className="mt-3 font-display text-[11px] italic text-ink-soft">
        Card congelado — sem propostas ou aprovações até o Bastão confirmar.
      </p>

      <div className="mt-4 border-t border-ink/10 pt-3">
        <button
          onClick={() => setModalEmerg(true)}
          className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-yellow-700 underline-offset-2 hover:underline"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          Caso excepcional? + Lançar outra oc emergencial
        </button>
      </div>

      <ModalLancarEmergencial
        cardId={card.id}
        nf={card.nf}
        isOpen={modalEmerg}
        onClose={() => setModalEmerg(false)}
      />
    </div>
  );
}
