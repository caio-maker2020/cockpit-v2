-- ============================================================================
-- Cockpit v2 — RLS em sync_status_global (correção alerta Supabase 2026-05-31)
-- Caio 2026-06-03
--
-- CONTEXTO: alerta de segurança do Supabase apontou rls_disabled_in_public na
-- única tabela do schema public sem RLS habilitada: sync_status_global. A
-- tabela tem 1 row (PK id=1) com timestamp do último sync do Bastão (sem PII).
-- GRANTs já existem (mig 167 linhas 34-35), mas sem RLS qualquer cliente com
-- a chave anon poderia fazer DELETE/UPDATE direto.
--
-- skill: supabase-postgres-best-practices
--   * RLS ON + 2 policies separadas (SELECT público, mutação service_role)
--   * Não usa security definer — function registrar_sync_bastao_concluido()
--     já está SECURITY DEFINER (mig 167) pra escrita controlada
--   * Padrão similar ao [[feedback_rls_grant_antes_de_policy]] — GRANTs
--     necessários já existem
-- ============================================================================

ALTER TABLE public.sync_status_global ENABLE ROW LEVEL SECURITY;

-- SELECT público: qualquer usuário autenticado (operadora) ou anon (front
-- antes do login mostrar heartbeat) pode ler o status global de sync. 1 row
-- só, dado público (sem PII), só timestamp/duração.
DROP POLICY IF EXISTS sync_status_global_select_public ON public.sync_status_global;
CREATE POLICY sync_status_global_select_public
  ON public.sync_status_global
  FOR SELECT
  TO authenticated, anon
  USING (true);

-- INSERT/UPDATE/DELETE só pra service_role (edge functions sync-bastao etc).
-- Operadora NÃO escreve direto — sempre via RPC registrar_sync_bastao_concluido.
DROP POLICY IF EXISTS sync_status_global_mutar_service_role ON public.sync_status_global;
CREATE POLICY sync_status_global_mutar_service_role
  ON public.sync_status_global
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
