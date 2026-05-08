-- ============================================================================
-- Cockpit v2 — Otimização Disk IO Budget
-- Data: 2026-05-07
--
-- Alerta Supabase: "Project is depleting its Disk IO Budget" no Cockpit-V2.
--
-- Diagnóstico (pg_stat_statements):
--   1. RPC `minutos_desde_ultimo_sync_bastao` — 772 calls, 3092ms mean,
--      204 MB de IO read. Causa: scan em cron.job_run_details (41k rows
--      crescendo +10k/dia, sem retenção).
--   2. cron.job_run_details + net._http_response cresce indefinidamente
--      (51 MB + 19 MB hoje, +10k rows/dia).
--   3. Front polling chama essa RPC frequentemente → IO escala linear.
--
-- Fixes:
--   1. Re-escreve RPC pra ler max(bastao_synced_at) de cards (~5k rows com
--      índice DESC = O(log n) em vez de scan de 41k rows + sort).
--   2. Cria função cleanup_cron_logs(p_days) que apaga registros > N dias
--      em cron.job_run_details + net._http_response.
--   3. Agenda cleanup diário às 04:00 UTC via pg_cron.
--   4. Índice em cards(bastao_synced_at DESC) pra MAX() ficar instantâneo.
-- ============================================================================

-- 1. Índice DESC pra MAX() instantâneo
CREATE INDEX IF NOT EXISTS idx_cards_bastao_synced_at_desc
  ON public.cards (bastao_synced_at DESC NULLS LAST)
  WHERE bastao_synced_at IS NOT NULL;

COMMENT ON INDEX public.idx_cards_bastao_synced_at_desc IS
  'Caio 2026-05-07: acelera RPC minutos_desde_ultimo_sync_bastao — MAX() vira '
  'Index Scan ao invés de seq scan de cron.job_run_details (41k+ rows).';

-- 2. RPC re-escrita: lê de cards em vez de cron.job_run_details
CREATE OR REPLACE FUNCTION public.minutos_desde_ultimo_sync_bastao()
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT GREATEST(
    0,
    FLOOR(EXTRACT(EPOCH FROM (now() - max(bastao_synced_at))) / 60)
  )::integer
  FROM public.cards
  WHERE bastao_synced_at IS NOT NULL;
$$;

COMMENT ON FUNCTION public.minutos_desde_ultimo_sync_bastao() IS
  'Caio 2026-05-07: lê max(bastao_synced_at) de cards (índice DESC) ao invés '
  'de scan de cron.job_run_details. Reduz IO read de ~250 KB/call pra <1 KB.';

-- 3. Função cleanup dos logs internos do Postgres
CREATE OR REPLACE FUNCTION public.cleanup_cron_logs(p_days_to_keep int DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cron_deleted bigint;
  v_http_deleted bigint;
  v_cutoff timestamptz;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  v_cutoff := now() - (p_days_to_keep || ' days')::interval;

  -- Apaga histórico antigo do pg_cron
  WITH del AS (
    DELETE FROM cron.job_run_details
    WHERE start_time < v_cutoff
    RETURNING 1
  )
  SELECT count(*) INTO v_cron_deleted FROM del;

  -- Apaga http_response antigos do extension net
  WITH del AS (
    DELETE FROM net._http_response
    WHERE created < v_cutoff
    RETURNING 1
  )
  SELECT count(*) INTO v_http_deleted FROM del;

  RETURN jsonb_build_object(
    'cutoff', v_cutoff,
    'days_kept', p_days_to_keep,
    'cron_job_run_details_deleted', v_cron_deleted,
    'net_http_response_deleted', v_http_deleted,
    'finalized_at', now()
  );
END;
$$;

COMMENT ON FUNCTION public.cleanup_cron_logs(int) IS
  'Caio 2026-05-07: apaga histórico antigo de cron.job_run_details + '
  'net._http_response. Default mantém 7 dias. Roda 1x/dia via pg_cron.';

REVOKE ALL ON FUNCTION public.cleanup_cron_logs(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_cron_logs(int) TO service_role;

-- 4. Agenda cleanup diário às 04:00 UTC (01:00 BRT — período de baixo tráfego)
-- Remove agendamento anterior (idempotente)
SELECT cron.unschedule('cleanup-cron-logs-daily')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'cleanup-cron-logs-daily'
);

SELECT cron.schedule(
  'cleanup-cron-logs-daily',
  '0 4 * * *',
  $$SELECT public.cleanup_cron_logs(7);$$
);
