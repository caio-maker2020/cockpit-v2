-- ============================================================================
-- Cockpit v2 — Cron diário pra processar-acoes-agendadas
-- Data: 2026-05-01
--
-- Roda 1x ao dia às 12h UTC (9h BRT). Hora pensada pra Larissa começar o
-- expediente já vendo as cobranças propostas no Cockpit.
-- ============================================================================

SELECT cron.unschedule('processar-acoes-agendadas-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'processar-acoes-agendadas-daily');

SELECT cron.schedule(
  'processar-acoes-agendadas-daily',
  '0 12 * * *',  -- 12h UTC = 9h BRT, todo dia
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/processar-acoes-agendadas',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);
