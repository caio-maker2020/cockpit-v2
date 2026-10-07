-- =============================================================================
-- 2026-10-07_432 — cron do materializar-fila-operacao (ADR 0041)
-- =============================================================================
-- Separada da 430 de propósito: a 430 só cria estrutura inerte e pode ser aplicada
-- a qualquer hora; ESTA liga um cron novo e só entra na hora de ligar (ADR 0041,
-- "Como ligar"). Agenda `materializar-fila-operacao` a cada 10 min. Com a flag operacao_fila OFF
-- a função responde `skipped: flag_off` (1 probe de auth + 1 SELECT da flag).
-- Alvo: Bastão (sem SSW).
--
-- TIPO B (o classificador acusa cron.unschedule; é idempotência do próprio job).
-- ORDEM: DEPOIS da 430 e do deploy de materializar-fila-operacao (senão o cron bate em função
-- inexistente — inofensivo, mas polui cron.job_run_details).
-- PULSO (INV-156): migration toca cron → conferir que
--   select max(start_time) from cron.job_run_details
-- avança nos 10 min seguintes. Sem essa contraprova a aplicação NÃO terminou.
-- SEGREDO: reusa o do vault `cron_sync_bastao_key` (o mesmo das migs 414/416 e dos
-- crons sync-bastao/sync-extravios); a edge confere que ele é service_role.
-- REVERSÃO: SELECT cron.unschedule('materializar-fila-operacao');
--
-- ⚠ NÃO APLICADA. ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

SELECT cron.unschedule('materializar-fila-operacao')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'materializar-fila-operacao');

SELECT cron.schedule(
  'materializar-fila-operacao',
  '*/10 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/materializar-fila-operacao',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) AS request_id;
  $cron$
);

DO $$
DECLARE
  v_jobs integer;
BEGIN
  SELECT count(*) INTO v_jobs FROM cron.job WHERE jobname = 'materializar-fila-operacao';
  IF v_jobs <> 1 THEN
    RAISE EXCEPTION 'Esperado exatamente 1 job materializar-fila-operacao, encontrado %', v_jobs;
  END IF;
  IF to_regclass('public.op_itens') IS NULL THEN
    RAISE EXCEPTION 'mig 432 exige a 430 aplicada antes (op_itens ausente)';
  END IF;
  RAISE NOTICE 'OK mig 432: cron materializar-fila-operacao agendado. Conferir o pulso (INV-156) nos próximos 10 min.';
END $$;
