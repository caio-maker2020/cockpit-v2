import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

type Filter =
  | { column: string; value: string | number }
  | undefined;

interface UseRealtimeTableProps {
  /** Nome da tabela (ex: "cards", "todos", "card_events") */
  table: "cards" | "todos" | "card_events" | "messages_inbox" | "sync_status_global" | string;
  /** Filtro opcional (ex: { column: "card_id", value: cardId }) — se omitir, escuta toda a tabela */
  filter?: Filter;
  /** Query keys a invalidar quando vier evento */
  queryKeys: Array<readonly unknown[]>;
  /** Pode desligar (ex: enabled: !!cardId) */
  enabled?: boolean;
}

/**
 * Substitui polling (refetchInterval) por push do Supabase Realtime.
 * Escuta postgres_changes na `table` (com filtro opcional) e invalida
 * as `queryKeys` no React Query quando vier qualquer evento.
 *
 * Pré-requisito: a tabela precisa estar na publication `supabase_realtime`.
 */
export function useRealtimeTable({
  table,
  filter,
  queryKeys,
  enabled = true,
}: UseRealtimeTableProps) {
  const qc = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !supabase) return;

    const channelName = filter
      ? `${table}_${filter.column}_${filter.value}_${Math.random().toString(36).slice(2, 8)}`
      : `${table}_all_${Math.random().toString(36).slice(2, 8)}`;

    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes" as never,
        {
          event: "*",
          schema: "public",
          table,
          ...(filter ? { filter: `${filter.column}=eq.${filter.value}` } : {}),
        },
        () => {
          // Debounce ~1s — evita refetch por evento individual quando vem rajada.
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            queryKeys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
          }, 1000);
        },
      )
      .subscribe();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      supabase!.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, filter?.column, filter?.value, enabled, JSON.stringify(queryKeys)]);
}
