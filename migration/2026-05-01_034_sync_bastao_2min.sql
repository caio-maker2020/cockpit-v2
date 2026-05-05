-- ============================================================================
-- Cockpit v2 — sync-bastao de 5min → 2min
-- Data: 2026-05-01
--
-- Reduz a janela de delay entre Bastão atualizar e Cockpit refletir.
-- Tempo médio antes: 150s (worst case 300s).
-- Tempo médio depois: 60s (worst case 120s).
--
-- Sync atual demora ~30s, então com 2min entre runs sobra 90s de folga
-- (sem risco de overlap).
-- ============================================================================

-- Atualiza RPC pra match LIKE em vez de jobname fixo (tolera renames)
CREATE OR REPLACE FUNCTION public.minutos_desde_ultimo_sync_bastao()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - max(jrd.start_time)))/60))::integer
  FROM cron.job_run_details jrd
  JOIN cron.job j ON j.jobid = jrd.jobid
  WHERE j.jobname LIKE 'sync-bastao-every-%'
    AND jrd.status = 'succeeded';
$$;
GRANT EXECUTE ON FUNCTION public.minutos_desde_ultimo_sync_bastao() TO authenticated, service_role;


SELECT cron.unschedule('sync-bastao-every-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-bastao-every-5min');

SELECT cron.schedule(
  'sync-bastao-every-2min',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/sync-bastao',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000
  ) AS request_id;
  $$
);
