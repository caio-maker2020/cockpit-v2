import { useQuery } from "@tanstack/react-query";
import { AlertOctagon } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";

/**
 * Banner vermelho mostrando a última falha de envio de e-mail / reversão pós-falha.
 * O envio é assíncrono — quando o executor falha, o card volta pra AGUARDANDO VOCÊ
 * e grava um card_event ("EmailNaoEnviado" ou "AcaoRevertidaPosFalha") com o motivo.
 * Sem este banner a operadora não percebe que algo deu errado.
 */
export function BannerEmailNaoEnviado({
  cardId,
  acaoFalhouMotivo,
}: {
  cardId: string;
  acaoFalhouMotivo: string | null;
}) {
  // Fonte ÚNICA da flag de falha ativa: cards.acao_falhou_motivo.
  // Eventos históricos (EmailNaoEnviado / AcaoRevertidaPosFalha / TripeRejeitadoPeloGuard)
  // permanecem na timeline, mas não devem ditar o estado atual — o backend zera
  // acao_falhou_motivo assim que uma ação subsequente dá certo (inclusive no override
  // "forçar lançamento em CTRC baixado"). Sem essa guarda, a flag fica grudada.
  const temFalhaAtiva = !!acaoFalhouMotivo && acaoFalhouMotivo.trim() !== "";

  const { data } = useQuery({
    queryKey: ["card-falha-envio", cardId],
    enabled: !!supabase && !!cardId && temFalhaAtiva,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("card_events")
        .select("event_type, payload, created_at")
        .eq("card_id", cardId)
        .in("event_type", ["EmailNaoEnviado", "AcaoRevertidaPosFalha"])
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      return (data ?? [])[0] as
        | { event_type: string; payload: any; created_at: string }
        | undefined;
    },
  });

  useRealtimeInvalidate(
    "card_events",
    ["card-falha-envio", cardId],
    `card_id=eq.${cardId}`,
  );

  if (!temFalhaAtiva) return null;
  if (!data) return null;

  // Se o evento for mais antigo que 24h, presume-se que já foi tratado
  const ageMs = Date.now() - new Date(data.created_at).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) return null;

  const motivo =
    data.payload?.motivo ??
    data.payload?.erro ??
    data.payload?.error ??
    "(sem detalhes)";

  const titulo =
    data.event_type === "EmailNaoEnviado"
      ? "O e-mail não foi enviado"
      : "Ação revertida por falha";

  return (
    <div
      role="alert"
      className="mx-6 mt-3 flex items-start gap-3 rounded-md border-2 border-rose-400 bg-rose-50 px-4 py-3"
    >
      <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
      <div className="min-w-0 flex-1">
        <p className="font-display text-[13px] font-semibold text-rose-900">
          ⚠ {titulo}
        </p>
        <p className="mt-1 text-[12px] leading-snug text-rose-900/90">
          {motivo}
        </p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-rose-700/80">
          {new Date(data.created_at).toLocaleString("pt-BR")}
        </p>
      </div>
    </div>
  );
}
