-- ============================================================================
-- Cockpit v2 — pg_cron schedules pra PRIORIDADES AI
-- Data: 2026-05-19
--
-- 3 crons:
--   1. sync-kanban-status-prioridades (madrugada, 03h UTC = 00h BRT)
--      Mantém cards.prioridades_kanban_status coerente.
--   2. agente-priorizador-ai (2×/dia: 11h e 17h UTC = 08h e 14h BRT)
--   3. agente-monitor-efetividade-ai (4×/dia: 09h, 15h, 20h, 01h UTC =
--      06h, 12h, 17h, 22h BRT)
--
-- Reusa secret `cron_cobranca_aguardando_key` do vault (mesma service_role).
-- ============================================================================

-- Garante secret no vault (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_prioridades_ai_key') THEN
    PERFORM vault.create_secret(
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_cobranca_aguardando_key' LIMIT 1),
      'cron_prioridades_ai_key',
      'Service role key reusada pra crons de PRIORIDADES AI (mig 129)'
    );
  END IF;
END $$;

-- 1. sync-kanban-status-prioridades — 1×/dia
SELECT cron.unschedule('sync-kanban-status-prioridades-daily') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname='sync-kanban-status-prioridades-daily'
);

SELECT cron.schedule(
  'sync-kanban-status-prioridades-daily',
  '0 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/sync-kanban-status-prioridades',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);

-- 2. agente-priorizador-ai — 2×/dia (11h e 17h UTC)
SELECT cron.unschedule('agente-priorizador-ai-2x') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname='agente-priorizador-ai-2x'
);

SELECT cron.schedule(
  'agente-priorizador-ai-2x',
  '0 11,17 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-priorizador-ai',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);

-- 3. agente-monitor-efetividade-ai — 4×/dia (09h, 15h, 20h UTC, 01h UTC)
SELECT cron.unschedule('agente-monitor-efetividade-ai-4x') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname='agente-monitor-efetividade-ai-4x'
);

SELECT cron.schedule(
  'agente-monitor-efetividade-ai-4x',
  '0 1,9,15,20 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-monitor-efetividade-ai',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);

COMMENT ON EXTENSION pg_cron IS 'pg_cron — agendamento de jobs (PRIORIDADES AI mig 129 + crons existentes)';
