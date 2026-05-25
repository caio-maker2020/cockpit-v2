-- =============================================================================
-- 2026-05-25_167 — sync_status cache (fix performance "última sync" do header)
--
-- Caio 2026-05-25 (plataforma lenta): função minutos_desde_ultimo_sync_bastao()
-- estava chamada 6038x/dia pelo header do Cockpit (polling do "última sync"),
-- consumindo ~42 min CPU/dia. Causa: SELECT max(bastao_synced_at) FROM cards
-- pagava 900ms de planning toda vez por causa dos 25 índices em cards (planner
-- re-avalia todos os índices em cada parse).
--
-- Fix: tabela sync_status_global (1 row, PK id=1), atualizada pelo final do
-- sync-bastao. Função vira PK lookup (sub-millisecond).
-- 6038 calls × ~1ms = 6 seg total = 99% economia.
--
-- skill: supabase-postgres-best-practices
--   - CREATE TABLE single-row pattern com CHECK constraint (id=1 sempre)
--   - SECURITY DEFINER mantém comportamento PostgREST anônimo
--   - GRANT SELECT pra authenticated (header do front lê)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sync_status_global (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ultimo_sync_bastao timestamptz,
  ultimo_sync_runtime_ms integer,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- Seed inicial — pega max atual e popula
INSERT INTO public.sync_status_global (id, ultimo_sync_bastao, atualizado_em)
SELECT 1, max(bastao_synced_at), now() FROM public.cards WHERE bastao_synced_at IS NOT NULL
ON CONFLICT (id) DO UPDATE SET
  ultimo_sync_bastao = EXCLUDED.ultimo_sync_bastao,
  atualizado_em = now();

GRANT SELECT ON public.sync_status_global TO authenticated, service_role, anon;
GRANT UPDATE ON public.sync_status_global TO service_role;

-- Reescreve a função pra ler do cache (sub-ms via PK lookup)
CREATE OR REPLACE FUNCTION public.minutos_desde_ultimo_sync_bastao()
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(
    0,
    FLOOR(EXTRACT(EPOCH FROM (now() - ultimo_sync_bastao)) / 60)
  )::integer
  FROM public.sync_status_global
  WHERE id = 1;
$$;

-- RPC pra service_role atualizar no final do sync-bastao
CREATE OR REPLACE FUNCTION public.registrar_sync_bastao_concluido(p_runtime_ms integer DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.sync_status_global (id, ultimo_sync_bastao, ultimo_sync_runtime_ms, atualizado_em)
  VALUES (1, now(), p_runtime_ms, now())
  ON CONFLICT (id) DO UPDATE SET
    ultimo_sync_bastao = EXCLUDED.ultimo_sync_bastao,
    ultimo_sync_runtime_ms = EXCLUDED.ultimo_sync_runtime_ms,
    atualizado_em = now();
$$;

REVOKE ALL ON FUNCTION public.registrar_sync_bastao_concluido(integer) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.registrar_sync_bastao_concluido(integer) TO service_role;

COMMENT ON TABLE public.sync_status_global IS
  'Cache single-row do timestamp do último sync-bastao concluído. Caio 2026-05-25: '
  'evita SELECT max(bastao_synced_at) FROM cards (900ms planning) chamado a cada '
  '10s pelo front. PK lookup = sub-ms.';
