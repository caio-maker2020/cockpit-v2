-- 2026-08-08_319 — cron do CHAT 2: o agente-chefe abre a pauta do dia às
-- 06:30 BRT (09:30 UTC), dias úteis (o skip de fim de semana é da function).
-- Flag-gated (aprendizado_chat_enabled) e idempotente (1 conversa aberta por
-- vez) — desligar a flag desliga a pauta sem tocar no cron.

SELECT cron.unschedule('agente-chefe-abre-conversa')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agente-chefe-abre-conversa');

SELECT cron.schedule(
  'agente-chefe-abre-conversa',
  '30 9 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-chefe-abre-conversa',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 240000
  ) AS request_id;
  $$
);
