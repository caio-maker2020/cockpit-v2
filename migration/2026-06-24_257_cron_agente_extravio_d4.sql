-- =============================================================================
-- Cron do agente-extravio-d4 (PART 2 M1) — scan horário (horário comercial BRT)
--
-- Caio 2026-06-24: o agente confere no SSW os cards de extravio com >= 4 dias
-- úteis. Modo "scan" (cron): marca 'recomendado' os limpos e 'nao_rodou' os que
-- já têm oc pós-extravio (coluna AUTÔNOMO NÃO RODOU). NÃO lança nada até a flag
-- extravios_agente_autonomo_enabled (M4). A própria função também gateia horário
-- comercial e a feature flag extravios_cockpit_enabled.
--
-- Cadência: de hora em hora, 11-21 UTC = 8-18 BRT (BRT=UTC-3, sem DST), seg-sex.
-- =============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('agente-extravio-d4')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agente-extravio-d4');
END $$;

SELECT cron.schedule(
  'agente-extravio-d4',
  '0 11-21 * * 1-5',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-extravio-d4',
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
