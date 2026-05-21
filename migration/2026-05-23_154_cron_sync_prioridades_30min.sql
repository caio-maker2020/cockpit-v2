-- ============================================================================
-- Cockpit v2 — Aumentar frequência atualização geral PRIORIDADES AI
-- Caio 2026-05-23
--
-- Antes: 5x/dia (10/12/14/17/19 UTC = 07/09/11/14/16 BRT) — gap de 2-3h.
-- Agora: cada 30min — garante historico_ssw sempre fresco e evita
-- dessincronização do cards.cod_ultima_ocorrencia (causa raiz do bug
-- NFs 1494315/1492103/2306334/2302499 perdidos em PRIORIDADES AI).
--
-- Custo: ~80s por run x 48 runs/dia = 64 min/dia de processamento. Aceitável.
-- ============================================================================

SELECT cron.unschedule('cron-sync-prioridades-ai-5x')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='cron-sync-prioridades-ai-5x');

SELECT cron.schedule(
  'cron-sync-prioridades-ai-30min',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/cron-sync-prioridades-ai',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
  $$
);
