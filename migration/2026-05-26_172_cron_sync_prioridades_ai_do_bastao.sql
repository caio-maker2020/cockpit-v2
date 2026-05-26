-- =============================================================================
-- 2026-05-26_172 — Cron sync-prioridades-ai-do-bastao a cada 1h
--
-- Caio 2026-05-26 (NFs 48883/21118/610294/696645 LARISSA invisíveis em
-- PRIORIDADES AI): a função sync-prioridades-ai-do-bastao já existe e importa
-- pendências oc=13/21 do Bastão como cards TRANSFERIDO (invisíveis no INBOX,
-- visíveis na aba PRIORIDADES AI). Faltava cron — só rodava manual.
--
-- Esta migration agenda execução a cada 1h. Importação é incremental
-- (cards_pulados_sem_mudanca não recria). Custo baixo no Bastão (1 query
-- por hora pra ~25 pendências em média).
--
-- skill: supabase-postgres-best-practices
--   - cron.schedule com SELECT cron.unschedule defensivo pra rerun
--   - Mesmo padrão dos outros crons (vault.decrypted_secrets pro token)
--   - timeout_milliseconds gentil — função pode levar até 120s
-- =============================================================================

DO $$
BEGIN
  -- Defensivo: se já existir, remove antes de recriar
  PERFORM cron.unschedule('sync-prioridades-ai-do-bastao-1h')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-prioridades-ai-do-bastao-1h');
END $$;

SELECT cron.schedule(
  'sync-prioridades-ai-do-bastao-1h',
  '15 * * * *', -- todo HH:15 — não conflita com outros crons (00, 30, 45)
  $$
    SELECT net.http_post(
      url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/sync-prioridades-ai-do-bastao',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
        'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);

COMMENT ON EXTENSION pg_cron IS
  'Caio 2026-05-26: novo cron sync-prioridades-ai-do-bastao-1h às HH:15 — importa pendências oc=13/21 do Bastão como cards TRANSFERIDO sem poluir INBOX.';
