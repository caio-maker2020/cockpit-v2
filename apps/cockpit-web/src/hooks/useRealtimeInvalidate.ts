import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Subscreve em postgres_changes em uma tabela e invalida a query do TanStack
 * indicada quando qualquer evento (INSERT/UPDATE/DELETE) ocorrer.
 *
 * Filtro opcional no formato Supabase realtime, ex.: "card_id=eq.<uuid>".
 *
 * IMPORTANTE: a invalidação é DEBOUNCED em ~1s para evitar tempestade de
 * refetches quando vários eventos chegam em sequência (alívio de carga no
 * banco — fix apagão 2026-06-23).
 */
export function useRealtimeInvalidate(
  table: string,
  queryKey: unknown[],
  filter?: string,
) {
  const qc = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!supabase) return;
    const channelName = `rt:${table}:${filter ?? "all"}:${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes" as never,
        { event: "*", schema: "public", table, ...(filter ? { filter } : {}) },
        () => {
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            qc.invalidateQueries({ queryKey });
          }, 1000);
        },
      )
      .subscribe();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      supabase!.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, filter, JSON.stringify(queryKey)]);
}
