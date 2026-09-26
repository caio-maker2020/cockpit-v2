-- =============================================================================
-- 2026-09-25_412 — cron do worker processar-pedidos-operacao (ADR 0035)
-- =============================================================================
-- Separada da 411 de propósito: a 411 só cria estrutura inerte e pode ser
-- aplicada a qualquer hora; ESTA liga um cron novo e só entra quando o time for
-- ligar os pedidos da operação (passo 6 do "Como ligar" do ADR 0035).
--
-- O que faz: agenda `processar-pedidos-operacao` a cada 1 min. Com a flag
-- ponte_operacao_pedidos OFF a função lê a flag e devolve `skipped: flag_off`
-- (1 SELECT, nada mais). A VAZÃO do SSW não depende do cron: a RPC
-- ponte_operacao_reservar_lancamentos conta a janela de 60 s no banco, então nem
-- cron duplicado nem chamada manual passam de 3 lançamentos/min.
--
-- TIPO B (o classificador acusa cron.unschedule; é idempotência do próprio job).
-- ORDEM: aplicar DEPOIS do deploy de processar-pedidos-operacao (senão o cron bate
-- em função inexistente — inofensivo, mas polui cron.job_run_details).
-- PULSO (INV-156): migration toca cron → conferir que
--   select max(start_time) from cron.job_run_details
-- avança nos 10 min seguintes. Sem essa contraprova a aplicação NÃO terminou.
-- SEGREDO: reusa o do vault `cron_sync_bastao_key`, igual à mig 410 e aos crons
-- sync-bastao/sync-extravios. Se ele rotacionar, este cron quebra junto.
-- REVERSÃO: SELECT cron.unschedule('processar-pedidos-operacao');
--
-- ⚠ NÃO APLICADA. ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

SELECT cron.unschedule('processar-pedidos-operacao')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'processar-pedidos-operacao');

SELECT cron.schedule(
  'processar-pedidos-operacao',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/processar-pedidos-operacao',
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
  SELECT count(*) INTO v_jobs FROM cron.job WHERE jobname = 'processar-pedidos-operacao';
  IF v_jobs <> 1 THEN
    RAISE EXCEPTION 'Esperado exatamente 1 job processar-pedidos-operacao, encontrado %', v_jobs;
  END IF;
  IF to_regclass('public.ponte_operacao_pedidos') IS NULL THEN
    RAISE EXCEPTION 'mig 412 exige a 411 aplicada antes (ponte_operacao_pedidos ausente)';
  END IF;
  RAISE NOTICE 'OK mig 412: cron agendado. Conferir o pulso (INV-156) nos próximos 10 min.';
END $$;
