-- =============================================================================
-- Cron do agente-ressarcimento-relancar-54 (M3) — scan horário (horário comercial BRT)
--
-- Caio 2026-06-25: o agente roda o detector (54→46→49 "lançar 54") nos cards
-- parados na oc 49. Modo "scan" (cron): marca 'recomendado' (cria a proposta de
-- relançar só a 54 sem e-mail) / 'nao_rodou' / 'nao_aplica'. NÃO lança nada até a
-- flag ressarcimento_relancar54_autonomo_enabled (default OFF). A própria função
-- gateia horário comercial + a flag master ressarcimento_relancar54_enabled.
--
-- Cadência: de hora em hora, 11-21 UTC = 8-18 BRT (BRT=UTC-3, sem DST), seg-sex.
-- Roda :30 pra não competir com o agente-extravio-d4 (que roda :00).
-- =============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('agente-ressarcimento-relancar-54')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agente-ressarcimento-relancar-54');
END $$;

SELECT cron.schedule(
  'agente-ressarcimento-relancar-54',
  '30 11-21 * * 1-5',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-ressarcimento-relancar-54',
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
