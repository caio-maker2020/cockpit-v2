-- ============================================================================
-- Cockpit v2 — Ativa security_invoker nas views v_indicador_erros_*
-- Data: 2026-05-19
--
-- Bug detectado pelo Supabase advisor (2 ERRORs security_definer_view):
--   - public.v_indicador_erros_lancamento_base
--   - public.v_erros_lancamento_detalhe
--
-- Postgres 15+ default é security_definer; views sem `security_invoker=on`
-- rodam como `postgres` e BYPASSAM RLS das tabelas subjacentes — qualquer
-- operador autenticado vê linhas de qualquer outro.
--
-- Mesmo padrão da migration 109 (v_cancelamentos_reentrega) e da memory
-- feedback_views_publicas_security_invoker.md. Fix de 1 linha cada.
-- ============================================================================

ALTER VIEW public.v_indicador_erros_lancamento_base SET (security_invoker = on);
ALTER VIEW public.v_erros_lancamento_detalhe        SET (security_invoker = on);

COMMENT ON VIEW public.v_indicador_erros_lancamento_base IS
  'security_invoker=on garante que operador só vê linhas de cards seus '
  'via RLS herdada. Gestor vê tudo. Fix advisor 2026-05-19.';

COMMENT ON VIEW public.v_erros_lancamento_detalhe IS
  'security_invoker=on garante que operador só vê linhas de cards seus '
  'via RLS herdada. Gestor vê tudo. Fix advisor 2026-05-19.';
