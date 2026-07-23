-- 2026-07-23_309 — Cron do casador triador→card (F5)
-- Diário 05:45 BRT (08:45 UTC): vincula os runs do dia (janela de 3 dias
-- cobre atraso de card/reprocesso). Backlog histórico JÁ vencido na estreia
-- manual de 2026-07-23 (6.433 de 6.544 runs = 98,3% vinculados).

BEGIN;

DO $$
BEGIN
  PERFORM cron.unschedule('vincular-triador-cards')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vincular-triador-cards');
END $$;

SELECT cron.schedule(
  'vincular-triador-cards',
  '45 8 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/vincular-triador-cards',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'Content-Type', 'application/json'
    ),
    body := '{"lote":300,"janela_dias":3}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);

COMMIT;
