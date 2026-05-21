-- ============================================================================
-- Cockpit v2 — cron pra agente-sugere-ocs-padrao (oc=10/11/19/35) cada 5min
-- Caio 2026-05-23
--
-- Análogo ao cron oc=13 (mig 148) mas para ocs padrão. Universo: TODOS os
-- clientes/operadores. Reusa secret cron_prioridades_ai_key.
--
-- skill: supabase-postgres-best-practices
-- ============================================================================

SELECT cron.unschedule('agente-sugere-ocs-padrao')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='agente-sugere-ocs-padrao');

SELECT cron.schedule(
  'agente-sugere-ocs-padrao',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-sugere-ocs-padrao',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);
