# Lovable — Alívio Disk IO em produção (Supabase deu warning)

**Data:** 2026-05-24
**Contexto:** Supabase enviou warning de `Disk IO Budget depleting`. Diagnóstico via `pg_stat_statements` apontou 2 queries do front Lovable como maiores ofensoras isoladas. Backend já reduziu frequência de 3 crons (mig 163). Faltam estes 2 ajustes no Lovable.

---

## Fix 1 — Cachear `minutos_desde_ultimo_sync_bastao`

### Problema observado

A RPC `public.minutos_desde_ultimo_sync_bastao()` foi chamada **5.919 vezes** consumindo **5h36min totais** de tempo de banco (3.270ms por chamada via PostgREST). É a chamada que retorna o "ÚLTIMA SYNC: HÁ X MINUTOS" no header.

### Causa raiz no front

O Lovable está chamando essa RPC em alguma dessas formas (escolha qual aplica):

a) Re-renderização de componente que dispara fetch.
b) Polling com setInterval menor que 60s.
c) Toda navegação entre abas/cards re-busca o número.

### Patch

**Substituir polling agressivo por cache de 60s + refresh manual via botão "Atualizar":**

```tsx
// hooks/useUltimaSyncBastao.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export function useUltimaSyncBastao() {
  return useQuery({
    queryKey: ['ultima-sync-bastao'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('minutos_desde_ultimo_sync_bastao');
      if (error) throw error;
      return data as number;
    },
    staleTime: 60_000,           // 60s — não rebusca antes disso
    refetchInterval: 5 * 60_000, // 5min — refresh automático em background
    refetchOnWindowFocus: false, // não rebusca ao trocar de aba do browser
    refetchOnMount: false,       // não rebusca em re-mount de componente
  });
}

// uso no header:
function HeaderSync() {
  const { data: minutos, refetch } = useUltimaSyncBastao();
  return (
    <span className="font-mono text-caption">
      ÚLTIMA SYNC: HÁ {minutos ?? '—'} MINUTOS
      <button onClick={() => refetch()} className="ml-2">⟳</button>
    </span>
  );
}
```

### Impacto operacional

- Hoje: número fica fresco em "tempo real" (alguns segundos de defasagem).
- Pós-patch: número se atualiza sozinho a cada 5min, ou imediatamente ao clicar `⟳`.
- Operacionalmente nada muda — saber se foi "há 7 ou há 9 minutos" não influencia decisão.

### Estimativa de economia

De ~6000 calls/dia pra **~96 calls/dia × N operadores** (~300 calls/dia totais). **Redução de 95%+**.

---

## Fix 2 — Desligar `count exato` nas paginações de `card_events`

### Problema observado

A query "atividade recente" / timeline global gasta **1.339ms por chamada × 45.273 calls = 60.000s totais**. A query em si executa em 76ms — o que custa caro é o `SELECT count(*)` que o PostgREST adiciona pra calcular `total_result_set` (pra mostrar "página X de Y" no front).

A query feia:
```sql
WITH pgrst_source AS (
  SELECT created_at FROM card_events
  WHERE event_type = ANY ($1)
  ORDER BY created_at DESC
  LIMIT $2 OFFSET $3
)
SELECT $4::bigint AS total_result_set,  -- ← este count exato é caro
       count(_postgrest_t) AS page_total,
       json_agg(_postgrest_t) AS body
FROM (SELECT * FROM pgrst_source) _postgrest_t
```

O `total_result_set` vem do header `Prefer: count=exact` (default do supabase-js quando você usa `{ count: 'exact' }`).

### Patch

**Trocar `count: 'exact'` por `count: 'estimated'` ou desligar count completamente** nas queries de listagem de eventos. Estimativa via `pg_class.reltuples` custa <1ms vs exact que faz full scan.

```tsx
// ANTES (lento — força count exato no banco)
const { data, count } = await supabase
  .from('card_events')
  .select('*', { count: 'exact' })
  .in('event_type', ['AcaoExecutada', 'CobrancaEscalonadaDisparada', ...])
  .order('created_at', { ascending: false })
  .range(0, 49);

// DEPOIS (rápido — estimativa de pg_class)
const { data, count } = await supabase
  .from('card_events')
  .select('*', { count: 'estimated' })  // ← muda aqui
  .in('event_type', ['AcaoExecutada', 'CobrancaEscalonadaDisparada', ...])
  .order('created_at', { ascending: false })
  .range(0, 49);

// AINDA MELHOR (se não usa o count): omite completamente
const { data } = await supabase
  .from('card_events')
  .select('*')  // ← sem count
  .in('event_type', [...])
  .order('created_at', { ascending: false })
  .range(0, 49);
```

### Onde aplicar

Qualquer query de listagem em `card_events` que tenha `count: 'exact'`. Provavelmente:
- Aba "Atividade recente" / timeline global
- Histórico do card
- Aba INDICADORES (alguns cards podem estar contando eventos)

### Estimativa de economia

Cada call cai de 1.339ms → ~80ms. Em 45k calls/dia, **economia de ~16h de banco/dia**.

### Quando manter `count: 'exact'`

Só pra tabelas pequenas (<1000 linhas) ou quando o número exato é crítico pro produto (raríssimo no nosso caso).

---

## Validação pós-patch

Depois de deployar, deixa rodar 24h e roda no banco:

```sql
-- Devem aparecer com `mean_exec_time` MUITO menor:
SELECT query, calls, round(mean_exec_time::numeric, 0) AS mean_ms,
       round((total_exec_time/1000)::numeric, 0) AS total_seg
FROM pg_stat_statements
WHERE query ILIKE '%minutos_desde_ultimo_sync_bastao%'
   OR (query ILIKE '%card_events%event_type%ANY%' AND query ILIKE '%total_result_set%')
ORDER BY total_exec_time DESC;
```

Espera ver:
- `minutos_desde_ultimo_sync_bastao`: calls/dia caindo de 6000 → 300
- `card_events ANY` query: mean_ms caindo de 1339 → ~100

---

## Resumo

| Fix | Esforço | Economia |
|---|---|---|
| Cache `minutos_desde_ultimo_sync_bastao` (60s + 5min auto-refresh) | 5 linhas TS | 95% IO desse endpoint |
| Trocar `count: 'exact'` → `'estimated'` em card_events | 1 char por query | 95% IO desse endpoint |

Nenhuma mudança de UX. Apenas troca a estratégia de fetching.
