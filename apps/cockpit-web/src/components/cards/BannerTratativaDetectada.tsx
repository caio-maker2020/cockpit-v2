import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";

/**
 * Linha DISCRETA no topo do detalhe do card quando o agente AUTO-ADOTOU
 * a thread do cliente (`cards.email_preexistente_sugerido.auto === true`).
 *
 * IMPORTANTE: NÃO é um banner gigante — toda a análise e a ação ("oc 54 + email")
 * continuam vindo do banner já existente (`ia_sugestao_oc_resposta` em ProposedActions).
 * Aqui só oferecemos o "Não é deste card · descartar".
 */
export interface EmailPreexistenteSugerido {
  auto?: boolean;
  roteamento?: "cliente_respondeu" | "aguardando_voce" | string;
  nota_agente?: string | null;
  thread_principal?: string | null;
  candidatos?: Array<{
    assunto?: string;
    participantes?: string[];
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

interface Props {
  cardId: string;
  sugerido: EmailPreexistenteSugerido | null | undefined;
}

export function BannerTratativaDetectada({ cardId, sugerido }: Props) {
  const qc = useQueryClient();
  const [descartando, setDescartando] = useState(false);

  if (!sugerido || sugerido.auto !== true) return null;

  async function descartar() {
    if (!supabase) return;
    if (
      !window.confirm(
        "Descartar a thread detectada? As mensagens importadas vão sumir e o card volta ao estado anterior.",
      )
    )
      return;

    setDescartando(true);
    const { data, error } = await supabase.rpc("descartar_email_preexistente", {
      p_card_id: cardId,
    });
    setDescartando(false);

    if (error || !(data as { ok?: boolean })?.ok) {
      toast.error(error?.message ?? "Erro ao descartar");
      return;
    }

    toast.success("Tratativa descartada — card revertido.");
    qc.invalidateQueries({ queryKey: ["card", cardId] });
    qc.invalidateQueries({ queryKey: ["tratativas-email", cardId] });
    qc.invalidateQueries({ queryKey: ["mensagens", cardId] });
  }

  return (
    <div className="mx-6 mt-2 flex items-center justify-between gap-2 border-l-2 border-l-indigo-500 bg-indigo-50/60 px-3 py-1.5 text-indigo-950">
      <span className="font-mono text-[10px] uppercase tracking-widest">
        📨 Tratativa do cliente detectada pelo agente · thread principal marcada nas Mensagens
      </span>
      <button
        type="button"
        onClick={descartar}
        disabled={descartando}
        className="shrink-0 border border-indigo-700/40 bg-transparent px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider hover:bg-indigo-200/60 disabled:opacity-40"
      >
        {descartando ? "..." : "não é deste card · descartar"}
      </button>
    </div>
  );
}
