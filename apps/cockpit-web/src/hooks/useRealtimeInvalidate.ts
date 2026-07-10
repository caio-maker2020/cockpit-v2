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
  const jaSubscreveuRef = useRef(false);

  useEffect(() => {
    if (!supabase) return;
    jaSubscreveuRef.current = false;
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
      // Callback de status: sem ele, uma queda de socket passava despercebida
      // e os eventos perdidos durante a queda NUNCA chegavam — a lista ficava
      // velha em silêncio (o "card não atualizou"). No REjoin após reconexão,
      // invalida pra backfillar o que se perdeu. O supabase-js reconecta e
      // re-subscreve sozinho; aqui a gente só reage a isso.
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          // 1ª vez: a query já buscou no mount, não reinvalida (evita refetch
          // redundante). Vezes seguintes = reconexão → backfill.
          if (jaSubscreveuRef.current) {
            qc.invalidateQueries({ queryKey });
          }
          jaSubscreveuRef.current = true;
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn(
            `[realtime] canal ${table} status=${status} — reconectando; refetch no rejoin.`,
          );
        }
      });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      supabase!.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, filter, JSON.stringify(queryKey)]);
}
