-- ============================================================================
-- Cockpit v2 — Agenda vinculador e executor a cada 1min
-- Data: 2026-04-29
--
-- Mesmas convenções dos crons sync-bastao e triador (vault key + net.http_post).
-- ============================================================================

-- vinculador
SELECT cron.unschedule('vinculador-every-1min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vinculador-every-1min');

SELECT cron.schedule(
  'vinculador-every-1min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/vinculador',
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

-- executor
SELECT cron.unschedule('executor-every-1min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'executor-every-1min');

SELECT cron.schedule(
  'executor-every-1min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/executor',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  ) AS request_id;
  $$
);
