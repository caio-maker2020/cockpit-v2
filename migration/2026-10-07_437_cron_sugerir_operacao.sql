-- =============================================================================
-- 2026-10-07_437 — cron do sugerir-operacao (ADR 0041 D10/D11)
-- =============================================================================
-- Separada das 434–436 de propósito: elas só criam estrutura inerte; ESTA liga um
-- cron novo e só entra na hora de ligar (ADR 0041, "Como ligar"). Agenda
-- `sugerir-operacao` a cada 10 min (5 min depois do materializador, para pegar os
-- itens novos da rodada). Com as flags operacao_sugestao_ia e
-- operacao_encaminhar_auto OFF a função só promove encaminhamentos agendados (nenhum,
-- enquanto a auto estiver OFF) e responde. Sem SSW; a Anthropic só com a flag de IA ON.
--
-- TIPO B (o classificador acusa cron.unschedule; é idempotência do próprio job).
-- ORDEM: DEPOIS das 434–436 e do deploy de sugerir-operacao (senão o cron bate em função
-- inexistente — inofensivo, mas polui cron.job_run_details).
-- PULSO (INV-156): migration toca cron → conferir que
--   select max(start_time) from cron.job_run_details
-- avança nos 10 min seguintes. Sem essa contraprova a aplicação NÃO terminou.
-- SEGREDO: reusa o do vault `cron_sync_bastao_key` (o mesmo das migs 414/416 e dos
-- crons sync-bastao/sync-extravios); a edge confere que ele é service_role.
-- REVERSÃO: SELECT cron.unschedule('sugerir-operacao');
--
-- ⚠ NÃO APLICADA. ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

SELECT cron.unschedule('sugerir-operacao')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sugerir-operacao');

SELECT cron.schedule(
  'sugerir-operacao',
  '5-59/10 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/sugerir-operacao',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  ) AS request_id;
  $cron$
);

DO $$
DECLARE
  v_jobs integer;
BEGIN
  SELECT count(*) INTO v_jobs FROM cron.job WHERE jobname = 'sugerir-operacao';
  IF v_jobs <> 1 THEN
    RAISE EXCEPTION 'Esperado exatamente 1 job sugerir-operacao, encontrado %', v_jobs;
  END IF;
  IF to_regclass('public.op_encaminhamentos') IS NULL THEN
    RAISE EXCEPTION 'mig 437 exige as 434–436 aplicadas antes (op_encaminhamentos ausente)';
  END IF;
  RAISE NOTICE 'OK mig 437: cron sugerir-operacao agendado. Conferir o pulso (INV-156) nos próximos 10 min.';
END $$;
