import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { CardRow } from "@/lib/types";
import { useTratativasEmail } from "@/hooks/useTratativasEmail";
import { mensagemDoResultadoScan } from "@/lib/scan-tratativa-resultado";

/**
 * Botão sob demanda: roda o scan de e-mail pré-existente SÍNCRONO via
 * edge function `scan-email-pre-card`. Mostra o resultado na hora —
 * o operador não fica no escuro esperando worker.
 *
 * Só aparece em cards ATIVOS que ainda NÃO têm nenhuma tratativa de e-mail.
 */
const ACTIVE_STATES = new Set([
  "AGUARDANDO_VALIDACAO_HUMANA",
  "AGUARDANDO_CLIENTE",
  "AGUARDANDO_AGENTE",
  "AGUARDANDO_CONTEXTO",
  "EM_TRIAGEM",
]);

type ScanResultado =
  | "sugerido"
  | "nenhum_candidato"
  | "sem_credencial_gmail"
  | "sem_operador"
  | "sem_nf"
  | "card_inexistente"
  | string;

interface ScanResponse {
  ok: boolean;
  error?: string;
  resultado?: {
    resultado: ScanResultado;
    candidatos_total?: number;
    melhor_score?: number;
  };
}

export function BotaoBuscarTratativa({ card }: { card: CardRow }) {
  const qc = useQueryClient();
  const [carregando, setCarregando] = useState(false);
  const { data: tratativas } = useTratativasEmail(card.id);

  if (!ACTIVE_STATES.has(card.state as string)) return null;
  if ((tratativas?.total_tratativas ?? 0) > 0) return null;

  const sug = (card as unknown as { email_preexistente_sugerido?: { auto?: boolean } | null })
    .email_preexistente_sugerido;
  if (sug?.auto === true) return null;

  async function handleBuscar() {
    if (!supabase) return;
    setCarregando(true);
    try {
      const { data, error } = await supabase.functions.invoke<ScanResponse>(
        "scan-email-pre-card",
        { body: { scan_card_id: card.id, contexto: "card_em_espera" } },
      );

      if (error || !data?.ok) {
        toast.error(data?.error || error?.message || "Erro ao buscar tratativa");
        return;
      }

      // NF 108141: scan com sucesso (adotado/ja_decidido/card_terminal) não pode
      // virar toast de erro. Mapeamento centralizado + testado em
      // lib/scan-tratativa-resultado.ts.
      const msg = mensagemDoResultadoScan(
        data.resultado?.resultado,
        data.resultado?.candidatos_total ?? 0,
      );
      if (msg.tipo === "success") toast.success(msg.texto);
      else if (msg.tipo === "error") toast.error(msg.texto);
      else toast(msg.texto);

      if (msg.refresh) {
        qc.invalidateQueries({ queryKey: ["card", card.id] });
        qc.invalidateQueries({ queryKey: ["cards"] });
        qc.invalidateQueries({ queryKey: ["email-preexistente", card.id] });
        qc.invalidateQueries({ queryKey: ["email-preexistente"] });
        qc.invalidateQueries({ queryKey: ["tratativas-email", card.id] });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao buscar tratativa");
    } finally {
      setCarregando(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleBuscar}
      disabled={carregando}
      title="Busca, agora, uma thread antiga desse cliente com essa NF no Gmail do operador."
      className="inline-flex items-center gap-1 border border-ink/20 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-soft transition-colors hover:border-ink hover:text-ink disabled:opacity-40"
    >
      {carregando ? (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          Buscando no Gmail…
        </>
      ) : (
        "📨 Já tem tratativa? Buscar"
      )}
    </button>
  );
}
