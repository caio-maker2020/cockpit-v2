# Lovable — Substituir polling por Supabase Realtime (cards, todos, card_events)

**Data:** 2026-05-25
**Motivação:** plataforma estava lenta. Diagnóstico no banco: `SELECT todos` consumindo 20h de CPU/dia (387ms × 187k chamadas) e `SELECT card_events` 17h CPU/dia (1334ms × 46k chamadas) — total ~37h de CPU acumulado/dia só em **polling do front sem cache**. Trocando por Realtime push, esperamos **redução de 90-95%** dessa carga.

**Backend:** tabelas `cards`, `todos`, `card_events` já estão no `supabase_realtime` publication. RLS já aplicada. Não precisa criar nada.

---

## Princípio

```
ANTES: refetchInterval: 3000  → request a cada 3s, sempre (mesmo sem mudança)
DEPOIS: subscription Realtime → request inicial + push do servidor SÓ quando muda
```

React Query continua sendo a fonte de verdade no cliente — Realtime apenas dispara `invalidateQueries()` quando o backend notifica mudança.

---

## Padrão genérico: hook `useRealtimeTable`

Crie `src/hooks/useRealtimeTable.ts`:

```ts
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

type Filter =
  | { column: string; value: string | number }
  | undefined;

interface UseRealtimeTableProps {
  /** Nome da tabela (ex: "cards", "todos", "card_events") */
  table: "cards" | "todos" | "card_events" | string;
  /** Filtro opcional (ex: { column: "card_id", value: cardId }) — se omitir, escuta toda a tabela */
  filter?: Filter;
  /** Query keys a invalidar quando vier evento */
  queryKeys: Array<readonly unknown[]>;
  /** Pode desligar (ex: enabled: !!cardId) */
  enabled?: boolean;
}

export function useRealtimeTable({ table, filter, queryKeys, enabled = true }: UseRealtimeTableProps) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    const channelName = filter
      ? `${table}_${filter.column}_${filter.value}`
      : `${table}_all`;

    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table,
          ...(filter ? { filter: `${filter.column}=eq.${filter.value}` } : {}),
        },
        () => {
          queryKeys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, filter?.column, filter?.value, enabled]);
}
```

---

## Aplicação 1: lista de cards (Kanban / INBOX)

No componente do Kanban/Inbox, **remover `refetchInterval`** da query e adicionar o hook:

```tsx
const { data: cards } = useQuery({
  queryKey: ["cards-inbox"],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("cards")
      .select("id, nf, ctrc, state, lock_aguardando_validacao, pagador, agent_state, cod_ultima_ocorrencia, responsavel_relacionamento, /* ... */")
      .in("state", ["AGUARDANDO_AGENTE", "AGUARDANDO_VALIDACAO_HUMANA", "AGUARDANDO_CLIENTE"])
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },
  staleTime: 60_000,  // cache 60s — Realtime invalida quando precisar
  // refetchInterval: REMOVIDO
  // refetchOnWindowFocus: false (opcional, evita refetch ao tabar)
});

useRealtimeTable({
  table: "cards",
  queryKeys: [["cards-inbox"]],
});
```

---

## Aplicação 2: todos pendentes do card aberto

No componente que mostra propostas pendentes no detalhe do card:

```tsx
const { data: todos } = useQuery({
  queryKey: ["card-todos", cardId],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("todos")
      .select("id, status, descricao, proposta_payload, created_at")
      .eq("card_id", cardId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },
  staleTime: 30_000,
  enabled: !!cardId,
});

useRealtimeTable({
  table: "todos",
  filter: { column: "card_id", value: cardId },
  queryKeys: [["card-todos", cardId]],
  enabled: !!cardId,
});
```

---

## Aplicação 3: histórico de eventos (`v_card_events_legivel`)

A view `v_card_events_legivel` lê de `card_events` — escutamos a tabela base:

```tsx
const { data: eventos } = useQuery({
  queryKey: ["historico-eventos", cardId],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("v_card_events_legivel")
      .select("*")
      .eq("card_id", cardId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return data;
  },
  staleTime: 60_000,
  enabled: !!cardId,
});

useRealtimeTable({
  table: "card_events",      // escuta a base, não a view
  filter: { column: "card_id", value: cardId },
  queryKeys: [["historico-eventos", cardId]],
  enabled: !!cardId,
});
```

---

## Aplicação 4: header "última sync" (já cacheado no backend agora)

A função `minutos_desde_ultimo_sync_bastao()` já é sub-millisecond depois do fix backend de hoje. Mesmo assim, **aumenta o intervalo de polling** desse componente — 1 minuto chega bem (a sync roda a cada 5min):

```tsx
const { data: minSinceSync } = useQuery({
  queryKey: ["minutos-desde-sync"],
  queryFn: async () => {
    const { data, error } = await supabase.rpc("minutos_desde_ultimo_sync_bastao");
    if (error) throw error;
    return data as number;
  },
  refetchInterval: 60_000,  // 1 minuto (era ~3-5s antes, pelo que vimos no log)
  staleTime: 30_000,
});
```

OU, se quiser zero polling, escutar a tabela `sync_status_global`:

```tsx
useRealtimeTable({
  table: "sync_status_global",
  queryKeys: [["minutos-desde-sync"]],
});
```

---

## Checklist de remoção

Procure no projeto e remova:

- `refetchInterval: 1000` → `2000` → `5000` em qualquer query de `cards`, `todos`, `card_events`, `messages_inbox`.
- Manter `refetchInterval` APENAS pra dados que mudam por processos externos sem trigger Realtime (ex: status de cron, status do Bastão).
- `refetchOnWindowFocus: true` (default do React Query) — manter se a UX gostar. Senão, mude pra `false` em queries pesadas.

---

## Validação após deploy

1. No app: abrir uma NF, aprovar uma proposta de outro tab/aba. **A lista de propostas no tab anterior deve atualizar sem F5** (Realtime push).
2. No banco depois de 1h rodando:
   ```sql
   SELECT mean_exec_time::int, calls, query
   FROM pg_stat_statements
   WHERE query ILIKE '%FROM "public"."todos"%'
     AND calls > 100
   ORDER BY mean_exec_time*calls DESC LIMIT 5;
   ```
   Esperar ver **calls/hora caindo 90%+** comparado com baseline atual.

---

## Resumo do impacto

| Query | Antes | Depois (esperado) |
|---|---|---|
| SELECT todos polling | 187k chamadas/dia | ~20k chamadas/dia (push só quando muda) |
| SELECT card_events polling | 46k chamadas/dia | ~5k chamadas/dia |
| CPU total/dia | ~37h | ~3-5h |

Cola no Lovable: ele entende `useRealtimeTable` + React Query padrão.
