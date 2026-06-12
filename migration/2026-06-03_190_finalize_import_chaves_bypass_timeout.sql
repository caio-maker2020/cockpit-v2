-- ============================================================================
-- Cockpit v2 — finalize_import_chaves_cte: ALTER FUNCTION SET statement_timeout=0
-- Caio 2026-06-03
--
-- CONTEXTO: RPA OPC 455 estava ficando "partial" mesmo importando 100% dos
-- batches porque a etapa finalize (DELETE de sessões antigas em ~700k rows)
-- batia no statement_timeout=8s do role authenticator do Supabase.
--
-- A função JÁ tinha PERFORM set_config('statement_timeout','0',true) dentro
-- do BEGIN, mas via PostgREST o authenticator timeout é cancelando a chamada
-- ANTES do set_config local entrar em vigor (cancel disparado em ~9s).
--
-- Fix: ALTER FUNCTION ... SET statement_timeout = '0' aplica o GUC no momento
-- em que a função é chamada, ANTES do código rodar — equivale a SET LOCAL no
-- início mas executado pelo runtime, não pelo plpgsql. Idem lock_timeout.
--
-- skill: supabase-postgres-best-practices
--   * ALTER FUNCTION ... SET <param> = <value> é GUC override no escopo da função
--   * Mantém SECURITY DEFINER + search_path existentes
--   * Função inteira chuncks de 50k já existem; só precisa o timeout fora.
--   * Caso âncora: importação 03/06 18:21Z (683 batches, 677k inseridos) +
--     finalize falhou 3x antes do fix; rodado manualmente via psql como
--     workaround.
-- ============================================================================

ALTER FUNCTION public.finalize_import_chaves_cte(text)
  SET statement_timeout = '0';

ALTER FUNCTION public.finalize_import_chaves_cte(text)
  SET lock_timeout = '60s';

COMMENT ON FUNCTION public.finalize_import_chaves_cte(text) IS
  'Caio 2026-06-03: ALTER FUNCTION SET statement_timeout=0 e lock_timeout=60s '
  'pra contornar authenticator timeout de 8s no Supabase. RPA OPC 455 chamava '
  'a função via PostgREST e batia timeout antes do PERFORM set_config interno '
  'pegar. Agora o GUC entra em vigor no momento da invocação.';
