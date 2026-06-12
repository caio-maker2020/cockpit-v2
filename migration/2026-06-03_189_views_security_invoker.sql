-- ============================================================================
-- Cockpit v2 — security_invoker=on nas 3 views públicas restantes
-- Caio 2026-06-03
--
-- CONTEXTO: alerta Supabase 2026-05-31 cobriu sync_status_global (mig 188).
-- Análise complementar achou 3 views ainda com security_definer (padrão
-- Postgres 15+) que bypassam RLS — risco igual ao bug NF 141603 (memory
-- [[feedback_views_publicas_security_invoker]]): Larissa via cards do Duilio.
--
-- skill: supabase-postgres-best-practices
--   * ALTER VIEW SET (security_invoker = on) — herda RLS das tabelas base
--   * Policies de cards (gestor vê tudo, operador vê só seus) aplicam corretamente
--   * Views só usadas por edge functions (service_role) não são afetadas
--   * Auditoria: usuários gestor continuam vendo tudo, operador vê só dela
-- ============================================================================

ALTER VIEW public.v_oc21_aguardando_oc14
  SET (security_invoker = on);

ALTER VIEW public.vw_divergencias_bastao_tracking_recentes
  SET (security_invoker = on);

ALTER VIEW public.vw_invariante_status
  SET (security_invoker = on);
