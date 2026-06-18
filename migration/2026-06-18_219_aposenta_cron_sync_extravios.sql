-- =============================================================================
-- Aposenta o cron sync-extravios-bastao (ADR 0005 — sync único)
--
-- Caio 2026-06-18: o sync-bastao agora puxa relacionamento + extravio (6/9/16) e
-- roteia por regra (handleExtravioPendencia). O cron dedicado de extravios fica
-- redundante — desagenda pra não rodar em paralelo (evita corrida/dobro de
-- trabalho). A edge function continua existindo (pode ser chamada manualmente /
-- como backstop), só não tem mais cron próprio.
-- =============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('sync-extravios-bastao')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-extravios-bastao');
END $$;
