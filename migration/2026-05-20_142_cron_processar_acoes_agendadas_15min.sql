-- ============================================================================
-- Cockpit v2 — cron processar-acoes-agendadas: 1×/dia → a cada 4h
-- Caio 2026-05-20
--
-- Bug NF 1492103: cancelamento de reentrega agendado pra 2026-05-20T13:22 UTC
-- (+24h após oc=21 lançada) NÃO RODOU no horário. Cron rodava 1×/dia às 12:00
-- UTC — antes da ação ficar due, próximo run só dia seguinte 12:00 UTC (~23h
-- de atraso). Caio teve que cancelar manualmente.
--
-- Fix: cron passa a rodar a cada 4h (00/04/08/12/16/20 UTC). Latência máxima
-- cai de ~24h pra ~4h. Caio escolheu 4h ao invés de 15min — operador não
-- fica refresh-ando esperando cancelamento; 4h é mais que suficiente sem
-- gastar invocações à toa (6/dia em vez de 96/dia).
--
-- Função `processar-acoes-agendadas` já é idempotente (SELECT status='pendente'
-- AND executar_em <= now()), seguro rodar várias vezes sem efeito colateral.
-- ============================================================================

DO $$
DECLARE jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'processar-acoes-agendadas-daily';
  IF jid IS NOT NULL THEN
    PERFORM cron.alter_job(jid, '0 */4 * * *');
    RAISE NOTICE 'cron processar-acoes-agendadas rescheduled to 0 */4 * * *';
  ELSE
    RAISE NOTICE 'cron processar-acoes-agendadas-daily não encontrado (nada a fazer)';
  END IF;
END $$;
