-- ============================================================================
-- Cockpit v2 — Agenda triador a cada 1min
-- Data: 2026-04-29
--
-- Reusa vault.cron_sync_bastao_key (mesmo service_role JWT). Triador roda
-- mais frequente que sync-bastao (1min vs 5min) porque latência percebida
-- pelo cliente importa: mensagem entra → operador quer ver card classificado
-- "agora", não daqui a 5min.
-- ============================================================================

SELECT cron.unschedule('triador-every-1min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'triador-every-1min');

SELECT cron.schedule(
  'triador-every-1min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/triador',
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
