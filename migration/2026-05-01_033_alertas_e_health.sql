-- ============================================================================
-- Cockpit v2 — Tabela alertas_enviados + cron pra Edge Function health-check
-- Data: 2026-05-01
--
-- Alerting básico: Edge Function `health-check` roda a cada 5min, verifica
-- 6 condições críticas, e envia email pra caio@salexpress.com.br via
-- Postmark quando algo está errado. Cooldown de 1h por tipo de alerta
-- pra não inundar caixa.
--
-- Resumo diário: às 8h BRT (11h UTC) manda 1 email "tudo verde nas
-- últimas 24h" pra confirmar que o monitor mesmo está vivo.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.alertas_enviados (
  id           bigserial PRIMARY KEY,
  tipo         text NOT NULL,                  -- 'cron_failed', 'sync_errors', etc
  chave        text NOT NULL,                  -- discriminador (ex: nome do cron)
  enviado_em   timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  postmark_id  text
);

CREATE INDEX IF NOT EXISTS idx_alertas_tipo_chave_recente
  ON public.alertas_enviados(tipo, chave, enviado_em DESC);

COMMENT ON TABLE public.alertas_enviados IS
  'Histórico de alertas enviados pra caio@salexpress.com.br. Usada pra '
  'aplicar cooldown (mesmo alerta só re-envia após 1h) e auditoria.';

ALTER TABLE public.alertas_enviados ENABLE ROW LEVEL SECURITY;
-- Sem policy = service_role only

-- ============================================================================
-- RPCs auxiliares usadas pela Edge Function health-check
-- ============================================================================

-- Retorna cron jobs com >= p_min_failures falhas nos últimos p_minutes minutos
CREATE OR REPLACE FUNCTION public.cron_jobs_recent_failures(
  p_minutes int DEFAULT 30,
  p_min_failures int DEFAULT 3
) RETURNS TABLE (jobname text, failures bigint, last_error text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT
    j.jobname::text,
    count(*)::bigint AS failures,
    (array_agg(d.return_message ORDER BY d.start_time DESC))[1]::text AS last_error
  FROM cron.job j
  JOIN cron.job_run_details d ON d.jobid = j.jobid
  WHERE d.start_time > now() - make_interval(mins => p_minutes)
    AND d.status <> 'succeeded'
  GROUP BY j.jobname
  HAVING count(*) >= p_min_failures;
$$;

GRANT EXECUTE ON FUNCTION public.cron_jobs_recent_failures(int, int) TO service_role;

-- Retorna número de mensagens "vivas" numa queue pgmq (não-deletadas)
CREATE OR REPLACE FUNCTION public.pgmq_queue_length(p_queue text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_count bigint;
  v_table text;
BEGIN
  v_table := format('pgmq.q_%I', p_queue);
  EXECUTE format('SELECT count(*)::bigint FROM %s', v_table) INTO v_count;
  RETURN v_count;
EXCEPTION
  WHEN undefined_table THEN
    RETURN 0;  -- queue ainda não criada
END;
$$;

GRANT EXECUTE ON FUNCTION public.pgmq_queue_length(text) TO service_role;

-- ============================================================================
-- Cron: health-check a cada 5min (mesmo padrão dos outros crons —
-- usa vault secret 'cron_sync_bastao_key' que já está populado)
-- ============================================================================
SELECT cron.unschedule('health-check-every-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'health-check-every-5min');

SELECT cron.schedule(
  'health-check-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/health-check',
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
