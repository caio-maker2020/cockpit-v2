-- =============================================================================
-- GRANT SELECT em sync_runs pra authenticated
--
-- Caio 2026-05-20: bug "Última sync: —" continuou após mig 138 porque faltava
-- GRANT explícito. Sem GRANT, Postgres rejeita SELECT antes de avaliar RLS
-- (erro 42501 "permission denied for table sync_runs").
--
-- A RLS criada na mig 138 (RESTRICTIVE + PERMISSIVE filtrando por
-- summary->>'tipo' = 'cron_prioridades_ai') só funciona se o GRANT estiver
-- presente. RLS roda DEPOIS do GRANT.
--
-- Segurança: a RLS continua filtrando — authenticated só vê registros do
-- cron_prioridades_ai. Sem dados sensíveis expostos.
--
-- Idempotente (GRANT é additive).
-- =============================================================================

GRANT SELECT ON public.sync_runs TO authenticated;
