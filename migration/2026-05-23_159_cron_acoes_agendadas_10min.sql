-- ============================================================================
-- Cockpit v2 — cron processar-acoes-agendadas: 4h → 10min
-- Caio 2026-05-23
--
-- PROBLEMA: cancelamentos automáticos de reentrega (+24h pós oc=21) ficavam
-- esperando até 4h após o horário marcado pra rodar. Larissa/Duilio acabavam
-- forçando manualmente em vez de confiar no autônomo, perdendo o ganho do
-- agendamento (e correndo risco de esquecer).
--
-- Exemplo real (2026-05-22):
--   - acao 184: executar_em 13:47 BRT → próximo cron 17:00 BRT (3h13min depois)
--   - acao 188: executar_em 13:59 BRT → próximo cron 17:00 BRT (3h01min depois)
--   Operador forçou ambas em < 1min após executar_em.
--
-- FIX: cron a cada 10 minutos. Janela máxima de atraso cai pra 10min.
-- Função é idempotente (SELECT status='pendente' AND executar_em <= now())
-- e barata quando vazia (~3s, 0 chamadas externas). 144 runs/dia vs ~6 antes.
--
-- Update via cron.alter_job (mantém jobid). Segue padrão da mig 142.
-- ============================================================================

DO $$
DECLARE jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'processar-acoes-agendadas-daily';
  IF jid IS NULL THEN
    RAISE EXCEPTION 'cron processar-acoes-agendadas-daily não encontrado';
  END IF;
  PERFORM cron.alter_job(jid, '*/10 * * * *');
  RAISE NOTICE 'cron processar-acoes-agendadas rescheduled to */10 * * * * (jobid=%)', jid;
END $$;
