-- ============================================================================
-- Cockpit v2 — Cron pra IA resposta cliente (retry de falhas silenciosas)
-- Data: 2026-05-11
--
-- Bug raiz NFs 351849 / 351077 (Caio 2026-05-11): vinculador chama
-- interpretador-resposta-cliente SÍNCRONO timeout 30s; se Anthropic lento ou
-- erro transitório, só console.warn — card fica `cliente_respondeu_em`
-- preenchido mas `ia_sugestao_oc_resposta=null` pra sempre. Larissa abre o
-- card e vê "CLIENTE RESPONDEU" sem sugestão de oc.
--
-- Fix: edge function `cron-ia-resposta-pendentes` roda a cada 1min, varre cards
-- com cliente respondido sem sugestão IA, chama interpretador. Idempotente.
--
-- Reusa vault secret `cron_sync_bastao_key` (já tem service role key).
-- ============================================================================

SELECT cron.unschedule('cron-ia-resposta-pendentes-every-1min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cron-ia-resposta-pendentes-every-1min');

SELECT cron.schedule(
  'cron-ia-resposta-pendentes-every-1min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/cron-ia-resposta-pendentes',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);
