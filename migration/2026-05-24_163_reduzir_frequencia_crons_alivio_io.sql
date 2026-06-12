-- ============================================================================
-- Cockpit v2 — reduz frequência de crons pra aliviar Disk IO
-- Caio 2026-05-24
--
-- CONTEXTO: Supabase enviou aviso de Disk IO Budget depleting. Diagnóstico
-- via pg_stat_statements revelou:
--   - 22 crons ativos, 4 deles a cada 1 minuto
--   - minutos_desde_ultimo_sync_bastao(): 3.270ms/call, 5919 calls = 5h36min CPU
--   - SELECT card_events WHERE event_type=ANY ORDER BY created_at DESC: 1340ms/call
--   - SELECT todos WHERE card_id IN (...): 373ms/call × 183k calls
--   - Crons curtos somam (4 jobs × 1440 min/dia = 5760 execuções/dia)
--
-- Ajustes não-destrutivos (preserva fluxo operacional):
--
--   1. cron-ia-resposta-pendentes-every-1min: 1min → 5min
--      Polling de cards aguardando IA processar resposta do cliente.
--      5min é suficiente; cliente raramente responde dentro de 1min.
--      NÃO MUDA: triador/vinculador/executor (fila pgmq, precisam 1min).
--
--   2. processar-acoes-agendadas: 10min → 15min
--      Ontem (mig 159) subimos de 4h pra 10min. 15min ainda dá janela aceitável
--      pra cancelamento +24h (delay max 15min vs +24h é insignificante).
--
--   3. audit-invariante: 5min → 15min
--      Audit é diagnóstico, não bloqueante. 15min é mais que suficiente.
--
-- Economia estimada: ~70% das execuções desses 3 jobs/dia.
--
-- skill: supabase-postgres-best-practices
--   * cron.alter_job preserva jobid (sem race condition durante o switch)
-- ============================================================================

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  -- 1. cron-ia-resposta-pendentes: 1min → 5min
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'cron-ia-resposta-pendentes-every-1min';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, '*/5 * * * *');
    RAISE NOTICE 'cron-ia-resposta-pendentes: 1min → 5min (jobid=%)', v_jobid;
  END IF;

  -- 2. processar-acoes-agendadas: 10min → 15min
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'processar-acoes-agendadas-daily';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, '*/15 * * * *');
    RAISE NOTICE 'processar-acoes-agendadas: 10min → 15min (jobid=%)', v_jobid;
  END IF;

  -- 3. audit-invariante: 5min → 15min
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'audit-invariante-every-5min';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, '*/15 * * * *');
    RAISE NOTICE 'audit-invariante: 5min → 15min (jobid=%)', v_jobid;
  END IF;
END $$;
