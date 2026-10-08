-- =============================================================================
-- 2026-10-07_433 — cron do processar-lancamentos-operacao (ADR 0041)
-- =============================================================================
-- Separada da 430 de propósito: a 430 só cria estrutura inerte e pode ser aplicada
-- a qualquer hora; ESTA liga um cron novo e só entra na hora de ligar (ADR 0041,
-- "Como ligar"). Agenda `processar-lancamentos-operacao` a cada 1 min. Com a flag operacao_lancar_ssw OFF
-- a função responde `skipped: flag_off` (1 probe de auth + 1 SELECT da flag).
-- Alvo: SSW (pelo envelope da Operação, vazão contada no banco).
--
-- TIPO B (o classificador acusa cron.unschedule; é idempotência do próprio job).
-- ORDEM: DEPOIS da 430 e do deploy de processar-lancamentos-operacao (senão o cron bate em função
-- inexistente — inofensivo, mas polui cron.job_run_details).
-- PULSO (INV-156): migration toca cron → conferir que
--   select max(start_time) from cron.job_run_details
-- avança nos 10 min seguintes. Sem essa contraprova a aplicação NÃO terminou.
-- SEGREDO: reusa o do vault `cron_sync_bastao_key` (o mesmo das migs 417/419 e dos
-- crons sync-bastao/sync-extravios); a edge confere que ele é service_role.
-- REVERSÃO: SELECT cron.unschedule('processar-lancamentos-operacao');
--
-- ⚠ NÃO APLICADA. ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

SELECT cron.unschedule('processar-lancamentos-operacao')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'processar-lancamentos-operacao');

SELECT cron.schedule(
  'processar-lancamentos-operacao',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/processar-lancamentos-operacao',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $cron$
);

DO $$
DECLARE
  v_jobs integer;
BEGIN
  SELECT count(*) INTO v_jobs FROM cron.job WHERE jobname = 'processar-lancamentos-operacao';
  IF v_jobs <> 1 THEN
    RAISE EXCEPTION 'Esperado exatamente 1 job processar-lancamentos-operacao, encontrado %', v_jobs;
  END IF;
  IF to_regclass('public.op_itens') IS NULL THEN
    RAISE EXCEPTION 'mig 433 exige a 430 aplicada antes (op_itens ausente)';
  END IF;
  RAISE NOTICE 'OK mig 433: cron processar-lancamentos-operacao agendado. Conferir o pulso (INV-156) nos próximos 10 min.';
END $$;
