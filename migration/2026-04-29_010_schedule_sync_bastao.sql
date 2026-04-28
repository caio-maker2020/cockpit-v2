-- ============================================================================
-- Cockpit v2 — Agenda sync-bastao a cada 5min via pg_cron + pg_net
-- Data: 2026-04-29
--
-- Pré-condições (já satisfeitas):
--   - pg_cron e pg_net habilitadas (CREATE EXTENSION rodado no deploy).
--   - supabase_vault disponível.
--   - sync-bastao Edge Function deployada.
--
-- Vault: armazena o service_role key como secret. O cron job lê via
-- vault.decrypted_secrets — sem expor chave em queries / planos.
--
-- IMPORTANTE — Quando rotacionar a service_role key, atualize o vault:
--   SELECT vault.update_secret(
--     (SELECT id FROM vault.secrets WHERE name = 'cron_sync_bastao_key'),
--     '<nova_key>'
--   );
-- ============================================================================

-- ============================================================================
-- 1. Vault secret — service_role key pra autenticar a chamada da Edge Function
-- ============================================================================
-- IMPORTANTE: o valor real será populado fora deste arquivo (psql -c) pra evitar
-- commit do secret no repo. Esta migration cria a entrada com placeholder.
-- O bash do deploy substitui o placeholder. Se já existir, no-op.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_sync_bastao_key') THEN
    -- Cria com valor dummy. Será atualizado fora do migration.
    PERFORM vault.create_secret(
      'PLACEHOLDER_REPLACE_ME',
      'cron_sync_bastao_key',
      'Service role key usada pelo cron pra invocar Edge Function sync-bastao'
    );
  END IF;
END $$;

-- ============================================================================
-- 2. Cron job — invoca sync-bastao a cada 5min
-- ============================================================================
-- Remove job se já existir (idempotência da migration).
SELECT cron.unschedule('sync-bastao-every-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-bastao-every-5min');

SELECT cron.schedule(
  'sync-bastao-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/sync-bastao',
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

COMMENT ON EXTENSION pg_cron IS
  'Usado pelo Cockpit pra agendar sync-bastao (5min) e, no futuro, '
  'auditor/cleanup. Jobs em cron.job. Histórico em cron.job_run_details.';
