import { useQuery } from "@tanstack/react-query";
import { AlertOctagon, AlertTriangle, FileSearch } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import {
  escolherAvisoDevolucaoCte,
  EVENTOS_DEVOLUCAO_CTE,
  type EventoDevolucaoCte,
  type TomAviso,
} from "@/lib/devolucaoCteAviso";

/**
 * Aviso da devolução com CT-e obrigatório (ADR 0018).
 *
 * Aviso de CONTEXTO, de propósito fora da tabela de prioridade do
 * `painelDecisao`: a DECISÃO do card é a proposta de oc 44, que renderiza na
 * lista de ações. Isto aqui é o que a MARIA precisa SABER, não decidir.
 *
 * Toda a escolha de qual aviso mostrar vive em `lib/devolucaoCteAviso` (puro,
 * 16 testes). Aqui só se busca e se pinta — do jeito que os outros banners de
 * contexto já fazem.
 *
 * Silencioso quando não há nada: card fora do fluxo da devolução não ganha
 * ruído nenhum, e a query nem chega a rodar sem `cardId`.
 */
export function BannerDevolucaoCte({ cardId }: { cardId: string }) {
  const { data } = useQuery({
    queryKey: ["devolucao-cte-aviso", cardId],
    enabled: !!supabase && !!cardId,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("card_events")
        .select("event_type, payload, created_at")
        .eq("card_id", cardId)
        .in("event_type", EVENTOS_DEVOLUCAO_CTE as unknown as string[])
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as EventoDevolucaoCte[];
    },
  });

  useRealtimeInvalidate(
    "card_events",
    ["devolucao-cte-aviso", cardId],
    `card_id=eq.${cardId}`,
  );

  const aviso = escolherAvisoDevolucaoCte(data ?? [], Date.now());
  if (!aviso) return null;

  const ESTILO: Record<TomAviso, { borda: string; texto: string; Icone: typeof AlertTriangle }> = {
    urgente: { borda: "border-red-600/60", texto: "text-red-700", Icone: AlertOctagon },
    atencao: { borda: "border-amber-600/60", texto: "text-amber-700", Icone: AlertTriangle },
    info: { borda: "border-ink/30", texto: "text-ink-soft", Icone: FileSearch },
  };
  const { borda, texto, Icone } = ESTILO[aviso.tom];

  return (
    <div className={`mx-6 mt-2 border-l-2 ${borda} bg-paper px-3 py-2`}>
      <div className="flex items-start gap-2">
        <Icone className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${texto}`} aria-hidden />
        <div className="min-w-0">
          <p className={`font-mono text-[10px] uppercase tracking-widest ${texto}`}>
            devolução com CT-e
          </p>
          <p className="mt-0.5 text-[12px] font-medium text-ink">{aviso.titulo}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-ink-soft">{aviso.detalhe}</p>
        </div>
      </div>
    </div>
  );
}
