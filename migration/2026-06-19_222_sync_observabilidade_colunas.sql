-- =============================================================================
-- 2026-06-19_222_sync_observabilidade_colunas
--
-- Observabilidade do sync-bastao (fix do timeout 150s, 2026-06-19).
--
-- O sync-bastao grava, a cada run, o tempo gasto por FASE e por PASS em
-- sync_status_global (linha id=1), de forma INCREMENTAL — sobrevive ao kill do
-- timeout, então dá pra ver EXATAMENTE onde a run morre quando estoura:
--   - debug_sync:        { pull_ms, prefetch_ms, mainloop_ms, pulled, writes,
--                          unchanged, deferidas, reconciliadas }  (fases do Pass A)
--   - debug_sync_passes: { A, B, C, D, E, F }  (ms por pass)
--
-- Alimenta o alerta health-check.checkSyncBastaoNaoCompleta (aponta qual pass
-- estoura). Custo: alguns UPDATEs numa única linha por run (desprezível).
--
-- As colunas foram criadas direto no banco em 2026-06-19; esta migration apenas
-- VERSIONA (idempotente).
-- =============================================================================

ALTER TABLE public.sync_status_global
  ADD COLUMN IF NOT EXISTS debug_sync jsonb,
  ADD COLUMN IF NOT EXISTS debug_sync_passes jsonb;

COMMENT ON COLUMN public.sync_status_global.debug_sync IS
  'Observabilidade sync-bastao: timing das fases do Pass A (pull/prefetch/mainloop) + contadores. Gravado incremental, sobrevive ao timeout.';
COMMENT ON COLUMN public.sync_status_global.debug_sync_passes IS
  'Observabilidade sync-bastao: ms por pass (A..F). Gravado incremental após cada pass — mostra onde a run morre se estourar 150s.';
