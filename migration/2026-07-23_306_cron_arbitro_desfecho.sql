-- 2026-07-23_306 — Cron do Árbitro de Desfecho T+7 (F3)
-- Diário 05:15 BRT (08:15 UTC), antes do agente-aprendizado das 06:30 —
-- assim o orquestrador do dia já lê pares com desfecho fresco.
-- Estreia manual JÁ FEITA em 2026-07-23 (backlog de 2.191 pares carimbado).

BEGIN;

DO $$
BEGIN
  PERFORM cron.unschedule('arbitro-desfecho')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'arbitro-desfecho');
END $$;

SELECT cron.schedule(
  'arbitro-desfecho',
  '15 8 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/arbitro-desfecho',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'Content-Type', 'application/json'
    ),
    body := '{"lote":200}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);

COMMIT;
