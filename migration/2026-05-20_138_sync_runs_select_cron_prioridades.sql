-- =============================================================================
-- sync_runs: policy SELECT limitada a registros cron_prioridades_ai
--
-- Caio 2026-05-20: bug "Última sync: —" no front PRIORIDADES AI.
--
-- Causa: v_prioridades_ai_ultimo_sync usa security_invoker=on (correto, segue
-- INV de RLS por operador). Mas sync_runs tem policy RESTRICTIVE
-- 'sync_runs_service_only' com USING(false) que bloqueia TODO authenticated.
-- Resultado: view executa com RLS do operador → retorna NULL em tudo.
--
-- Fix: relaxar a RESTRICTIVE pra dar true em registros cron_prioridades_ai +
-- adicionar PERMISSIVE limitada ao mesmo tipo. Combinação:
--   - cron_prioridades_ai: RESTRICTIVE passa + PERMISSIVE passa → SELECT ok
--   - outros tipos: RESTRICTIVE falha → SELECT bloqueado
--   - service_role: bypassa RLS, lê tudo
--
-- Dados expostos: timestamp, contagem ok/falhou/total, duration_ms.
-- Sem dados sensíveis de card ou operador específico.
--
-- Idempotente.
-- =============================================================================

-- Recria a RESTRICTIVE substituindo USING(false) por filtro por tipo
DROP POLICY IF EXISTS sync_runs_service_only ON public.sync_runs;

CREATE POLICY sync_runs_service_only
  ON public.sync_runs
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING ((summary ->> 'tipo') = 'cron_prioridades_ai')
  WITH CHECK (false);  -- continua bloqueando INSERT/UPDATE/DELETE pra authenticated

-- PERMISSIVE pra autorizar SELECT no tipo específico
DROP POLICY IF EXISTS sync_runs_select_cron_prioridades_ai ON public.sync_runs;

CREATE POLICY sync_runs_select_cron_prioridades_ai
  ON public.sync_runs
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((summary ->> 'tipo') = 'cron_prioridades_ai');

COMMENT ON POLICY sync_runs_service_only ON public.sync_runs IS
  'RESTRICTIVE: authenticated SÓ pode ler registros do cron_prioridades_ai. '
  'Demais sync_runs continuam bloqueadas. WITH CHECK false bloqueia escrita. '
  'service_role bypassa toda RLS.';

COMMENT ON POLICY sync_runs_select_cron_prioridades_ai ON public.sync_runs IS
  'PERMISSIVE: autoriza SELECT em runs do cron-sync-prioridades-ai. Usado '
  'pela view v_prioridades_ai_ultimo_sync ("Última sync há X" no front).';
