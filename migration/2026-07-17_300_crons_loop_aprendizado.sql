-- 2026-07-17_300 — Crons do Loop de Aprendizado (Fase 1)
-- Spec: docs/superpowers/specs/2026-07-17-loop-aprendizado-agentes-design.md
--
-- 3 jobs (padrão da casa: net.http_post + vault cron_prioridades_ai_key):
--   agente-aprendizado-diario   06:30 BRT (09:30 UTC) — clusters + perguntas + heartbeat
--   agente-aprendizado-semanal  domingo 20:00 BRT (23:00 UTC) — relatório de segunda
--   watchdog-aprendizado        09:15 BRT (12:15 UTC) — dead-man alarm diário
--
-- Estreia manual JÁ FEITA em 2026-07-17 (relatório nº 1 + 5 perguntas geradas
-- e validadas) — estes crons só assumem a cadência daqui pra frente.

BEGIN;

DO $$
BEGIN
  PERFORM cron.unschedule('agente-aprendizado-diario')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agente-aprendizado-diario');
  PERFORM cron.unschedule('agente-aprendizado-semanal')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agente-aprendizado-semanal');
  PERFORM cron.unschedule('watchdog-aprendizado')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'watchdog-aprendizado');
END $$;

SELECT cron.schedule(
  'agente-aprendizado-diario',
  '30 9 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-aprendizado',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'Content-Type', 'application/json'
    ),
    body := '{"modo":"diario"}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'agente-aprendizado-semanal',
  '0 23 * * 0',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-aprendizado',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'Content-Type', 'application/json'
    ),
    body := '{"modo":"semanal"}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);

SELECT cron.schedule(
  'watchdog-aprendizado',
  '15 12 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/watchdog-aprendizado',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);

COMMIT;
