-- ============================================================================
-- Cockpit v2 — Cron pg_cron pra gmail-poll-inbox a cada 5min
-- Data: 2026-05-06
--
-- Reusa vault secret `cron_sync_bastao_key` (já tem service role key) — não
-- duplica secret pra cada cron.
-- ============================================================================

SELECT cron.unschedule('gmail-poll-inbox-every-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gmail-poll-inbox-every-5min');

SELECT cron.schedule(
  'gmail-poll-inbox-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/gmail-poll-inbox',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);
