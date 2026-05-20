-- =============================================================================
-- pg_cron + view de status pra sync autônomo de PRIORIDADES AI
--
-- Caio 2026-05-20: roda 5×/dia (07/09/11/14/16 horário de Brasília) o equivalente
-- ao botão "Atualizar Geral" do front, autônomo.
--
-- Horários BRT → UTC (Brasil = UTC-3):
--   07h BRT = 10h UTC
--   09h BRT = 12h UTC
--   11h BRT = 14h UTC
--   14h BRT = 17h UTC
--   16h BRT = 19h UTC
--
-- View `v_prioridades_ai_ultimo_sync` exposta pro front consumir "tempo desde
-- última sync". Security_invoker=on respeita RLS do operador autenticado.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. View de status: último sync bem-sucedido
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_prioridades_ai_ultimo_sync
WITH (security_invoker = on) AS
SELECT
  (SELECT id FROM public.sync_runs
   WHERE summary->>'tipo' = 'cron_prioridades_ai'
     AND status = 'succeeded'
   ORDER BY finished_at DESC NULLS LAST LIMIT 1) AS ultimo_run_id,
  (SELECT finished_at FROM public.sync_runs
   WHERE summary->>'tipo' = 'cron_prioridades_ai'
     AND status = 'succeeded'
   ORDER BY finished_at DESC NULLS LAST LIMIT 1) AS ultimo_sync_em,
  (SELECT summary FROM public.sync_runs
   WHERE summary->>'tipo' = 'cron_prioridades_ai'
     AND status = 'succeeded'
   ORDER BY finished_at DESC NULLS LAST LIMIT 1) AS ultimo_summary,
  (SELECT started_at FROM public.sync_runs
   WHERE summary->>'tipo' = 'cron_prioridades_ai'
     AND status = 'running'
   ORDER BY started_at DESC LIMIT 1) AS sync_em_andamento_iniciado_em;

GRANT SELECT ON public.v_prioridades_ai_ultimo_sync TO authenticated, service_role;

COMMENT ON VIEW public.v_prioridades_ai_ultimo_sync IS
  'Status do cron-sync-prioridades-ai. Front consulta pra mostrar "Última sync: há X minutos".';

-- ----------------------------------------------------------------------------
-- 2. Garante secret no vault (reusa cron_prioridades_ai_key da mig 129)
-- ----------------------------------------------------------------------------
-- (Já criada na mig 129. Aqui só desliga cron antigo se existir e cria novos.)

-- ----------------------------------------------------------------------------
-- 3. Cron 5×/dia: 07/09/11/14/16 BRT = 10/12/14/17/19 UTC
-- ----------------------------------------------------------------------------
SELECT cron.unschedule('cron-sync-prioridades-ai-5x') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'cron-sync-prioridades-ai-5x'
);

SELECT cron.schedule(
  'cron-sync-prioridades-ai-5x',
  '0 10,12,14,17,19 * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/cron-sync-prioridades-ai',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_prioridades_ai_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  ) AS request_id;
  $$
);
