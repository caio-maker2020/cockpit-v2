-- =============================================================================
-- 2026-09-14_391 — RPCs do monitor de capacidade com statement_timeout próprio
-- =============================================================================
-- Complemento da mig 390 (mesmo caso, Caio 14/09): mesmo com VACUUM + índice,
-- a PRIMEIRA chamada fria de acoes_negocio_periodo (30d) leva ~3,2s e morre no
-- statement_timeout de 3s do role anon → HTTP 500 → monitor "não carrega".
-- Medido: fria 3,2s; aquecida 0,35s. Receita do INV-090: timeout LOCAL às
-- funções do monitor (15s) — a primeira abertura do dia demora alguns
-- segundos e COMPLETA (aquecendo o cache pras seguintes), em vez de falhar.
-- Escopo cirúrgico: só as 6 RPCs do monitor (token-gated, read-only);
-- o timeout global do anon fica intocado. TIPO A (reversível: RESET).
-- skill: supabase-postgres-best-practices aplicada.
-- =============================================================================

ALTER FUNCTION public.acoes_negocio_periodo(text, date, date) SET statement_timeout = '15s';
ALTER FUNCTION public.agentes_periodo(text, date, date)       SET statement_timeout = '15s';
ALTER FUNCTION public.automacoes_periodo(text, date, date)    SET statement_timeout = '15s';
ALTER FUNCTION public.anthropic_usage_periodo(text, date, date) SET statement_timeout = '15s';
ALTER FUNCTION public.automacoes_falhas_periodo(text, date, date) SET statement_timeout = '15s';
ALTER FUNCTION public.painel_capacidade(text)                 SET statement_timeout = '15s';
