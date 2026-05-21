-- ============================================================================
-- Cockpit v2 — cron pra agente-oc13-autonomo (cada 5min)
-- Caio 2026-05-22
--
-- Varre cards AVH+lock=true + oc=13 + CNPJ ∈ cliente_config_oc13 + criados <6h.
-- Aplica árvore de decisão IA (autônomo ou sugestão) e atualiza analise_oc13_*.
--
-- skill: supabase-postgres-best-practices
--   * cron.schedule idempotente — usa job name único
--   * reusa secret existente cron_prioridades_ai_key (mesmo service_role)
--   * timeout 120s pra batch de 20 cards (cada análise ~10s)
-- ============================================================================

-- Remove cron antigo se existir (idempotência)
SELECT cron.unschedule('agente-oc13-autonomo') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'agente-oc13-autonomo'
);

SELECT cron.schedule(
  'agente-oc13-autonomo',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-oc13-autonomo',
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

COMMENT ON EXTENSION pg_cron IS 'cron jobs: agente-oc13-autonomo */5min Caio 2026-05-22';
