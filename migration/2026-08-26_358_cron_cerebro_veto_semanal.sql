-- =============================================================================
-- 2026-08-26_358_cron_cerebro_veto_semanal.sql
--
-- CÉREBRO do loop de aprendizado do veto (Caio 26/08: "pode construir"):
-- cron SEMANAL (segunda 07:00 BRT = 10:00 UTC) invocando a edge
-- cerebro-veto-dossie — agrega cancelamentos/correções/edições da semana,
-- classifica na taxonomia (Haiku), gera propostas por padrão n≥2 (Sonnet),
-- grava learning_log + abre a conversa do dossiê no chat do Aprendizado.
-- Nada vira regra sozinho: replay + ordem do Caio seguem obrigatórios.
--
-- Mesmo padrão de invocação dos crons da casa (vault cron_sync_bastao_key).
-- SEM begin/commit interno. Idempotente (unschedule antes).
-- =============================================================================

SELECT cron.unschedule('cerebro-veto-dossie-semanal')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cerebro-veto-dossie-semanal');

SELECT cron.schedule(
  'cerebro-veto-dossie-semanal',
  '0 10 * * 1',
  $cron$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/cerebro-veto-dossie',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{"dias": 7}'::jsonb,
    timeout_milliseconds := 300000
  ) AS request_id;
  $cron$
);
