import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/lib/supabase";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";

// Aviso "a Würth respondeu, mas é de outro ciclo" (Caio 2026-08-14, NF 677750).
//
// Sem isto a operadora não tem como saber a diferença entre "a Würth ainda não
// respondeu" e "respondeu, mas a resposta é de um ciclo anterior e foi
// desconsiderada" — o card fica calado nos dois casos, e o silêncio já custou
// duas oc 21 lançadas no SSW em cima de retorno velho (NFs 378673 e 674757).
//
// Lê o card_event RetornoIntranetWurthDescartado que o robô grava (guard de
// ciclo em _shared/wurth-ciclo.ts). Some sozinho quando chega retorno novo:
// só mostra o descarte se ele for POSTERIOR ao último retorno aceito.

interface EventoDescarte {
  created_at: string;
  payload: {
    linha?: { data_solucao?: string; solucao?: string; obs?: string };
    guard_ciclo?: { motivo?: string; gatilho?: { codigo?: number | null } };
    retroativo?: boolean;
  } | null;
}

export function WurthRetornoCicloAnteriorAviso({ cardId }: { cardId: string }) {
  const { data } = useQuery({
    queryKey: ["wurth-retorno-descartado", cardId],
    enabled: !!supabase,
    queryFn: async () => {
      const ultimo = async (tipo: string) => {
        const { data } = await supabase!
          .from("card_events")
          .select("created_at, payload")
          .eq("card_id", cardId)
          .eq("event_type", tipo)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return (data ?? null) as EventoDescarte | null;
      };
      const [descartado, aceito] = await Promise.all([
        ultimo("RetornoIntranetWurthDescartado"),
        ultimo("RetornoIntranetWurth"),
      ]);
      if (!descartado) return null;
      // retorno novo aceito depois do descarte → o aviso não vale mais
      if (aceito && aceito.created_at > descartado.created_at) return null;
      return descartado;
    },
  });

  useRealtimeInvalidate("card_events", ["wurth-retorno-descartado", cardId], `card_id=eq.${cardId}`);

  if (!data) return null;
  const linha = data.payload?.linha ?? {};
  const motivo = data.payload?.guard_ciclo?.motivo ?? "";

  return (
    <div className="rounded-md border border-warning/40 bg-warning/5 px-2.5 py-2 text-[11.5px] leading-snug text-ink">
      <p className="font-semibold text-warning">Ainda sem retorno da Würth para esta tratativa</p>
      <p className="mt-1 text-ink-soft">
        Existe resposta na intranet ({linha.data_solucao ?? "?"}
        {linha.solucao ? ` · ${linha.solucao}` : ""}), mas ela é de um <strong>ciclo anterior</strong> —
        a Würth respondeu antes da ocorrência que gerou esta tratativa. Desconsiderada pelo robô.
      </p>
      {linha.obs && <p className="mt-1 italic text-ink-mute">“{linha.obs}”</p>}
      {motivo && <p className="mt-1 font-mono text-[10px] text-ink-mute">{motivo}</p>}
    </div>
  );
}
