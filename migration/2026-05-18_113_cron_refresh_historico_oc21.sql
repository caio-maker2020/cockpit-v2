-- ============================================================================
-- Cockpit v2 — Cron a cada 6h pra refresh do historico_ssw em cards com oc=21
-- Data: 2026-05-18
--
-- Caio: garante que cards onde operador aprovou oc=21 nos últimos 5 dias
-- tenham historico_ssw fresh, pra que o tracking do 2º indicador (tempo 21→14)
-- e os alertas SLA enxerguem a oc=14 quando chegar do SSW.
--
-- Roda a cada 6h (4x/dia) — mais granular que os 12h sugeridos, sem rate-limit
-- excessivo (~ 50 cards × 4 = 200 chamadas SSW/dia).
-- ============================================================================

SELECT cron.unschedule('refresh-historico-cards-com-oc21-6h')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-historico-cards-com-oc21-6h');

SELECT cron.schedule(
  'refresh-historico-cards-com-oc21-6h',
  '30 */6 * * *',  -- minuto 30 a cada 6h (00:30, 06:30, 12:30, 18:30 UTC)
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/refresh-historico-cards-com-oc21',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);
