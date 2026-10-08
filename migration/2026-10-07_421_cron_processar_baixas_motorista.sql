-- =============================================================================
-- 2026-10-07_421 — cron do worker processar-baixas-motorista (ADR 0040)
-- =============================================================================
-- Separada da 420 de propósito: a 420 só cria estrutura inerte e pode ser
-- aplicada a qualquer hora; ESTA liga um cron novo e só entra quando o time for
-- ligar a baixa do motorista (passo 3 do "Como ligar" do ADR 0040).
--
-- O que faz: agenda `processar-baixas-motorista` a cada 1 min. Com a flag
-- baixa_motorista_receber OFF a função lê a flag e devolve `skipped: flag_off`
-- (1 SELECT). A VAZÃO do SSW não depende do cron: a RPC baixa_motorista_reservar
-- conta a janela de 60 s no banco, então nem cron duplicado nem chamada manual
-- passam de 3 lançamentos/min.
--
-- TIPO B (o classificador acusa cron.unschedule; é idempotência do próprio job).
-- ORDEM: aplicar DEPOIS do deploy de processar-baixas-motorista.
-- PULSO (INV-156): migration toca cron → conferir que
--   select max(start_time) from cron.job_run_details
-- avança nos 10 min seguintes. Sem essa contraprova a aplicação NÃO terminou.
-- SEGREDO: reusa o do vault `cron_sync_bastao_key`, igual às migs 417/419.
-- REVERSÃO: SELECT cron.unschedule('processar-baixas-motorista');
--
-- ⚠ NÃO APLICADA. ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

SELECT cron.unschedule('processar-baixas-motorista')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'processar-baixas-motorista');

SELECT cron.schedule(
  'processar-baixas-motorista',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/processar-baixas-motorista',
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
  SELECT count(*) INTO v_jobs FROM cron.job WHERE jobname = 'processar-baixas-motorista';
  IF v_jobs <> 1 THEN
    RAISE EXCEPTION 'Esperado exatamente 1 job processar-baixas-motorista, encontrado %', v_jobs;
  END IF;
  IF to_regclass('public.baixas_motorista') IS NULL THEN
    RAISE EXCEPTION 'mig 421 exige a 420 aplicada antes (baixas_motorista ausente)';
  END IF;
  RAISE NOTICE 'OK mig 421: cron agendado. Conferir o pulso (INV-156) nos próximos 10 min.';
END $$;
