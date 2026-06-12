-- ============================================================================
-- Cockpit v2 — run_managed_agent_query: executa SQL livre readonly pros
-- Managed Agents (chamado pela edge function managed-agent-tools).
-- Data: 2026-06-10
--
-- Combina:
--   - validar_sql_readonly (mig 199) pra rejeitar escrita
--   - SET LOCAL transaction_read_only = on pra defesa em profundidade
--   - SECURITY DEFINER pra rodar com privilégios suficientes pra agregar dados
-- ============================================================================

CREATE OR REPLACE FUNCTION public.run_managed_agent_query(p_sql text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Defesa 1: re-valida SQL (já validado na edge, mas paranoia)
  IF NOT public.validar_sql_readonly(p_sql) THEN
    RAISE EXCEPTION 'SQL rejeitado pelo validador readonly';
  END IF;

  -- Defesa 2: força sessão em read-only — qualquer INSERT/UPDATE/DELETE estoura
  PERFORM set_config('transaction_read_only', 'on', true);

  -- Executa e empacota como jsonb
  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM (%s) AS t LIMIT 500',
    p_sql
  ) INTO v_result;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- Statement timeout 10s — defesa contra query maligna travar conexão
ALTER FUNCTION public.run_managed_agent_query(text) SET statement_timeout = '10s';

REVOKE EXECUTE ON FUNCTION public.run_managed_agent_query(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_managed_agent_query(text) TO service_role;

COMMENT ON FUNCTION public.run_managed_agent_query IS
  'Executado pela edge function managed-agent-tools pra rodar SELECT/WITH livre dos Managed Agents. Defesas: (1) validar_sql_readonly, (2) transaction_read_only=on, (3) statement_timeout=10s, (4) LIMIT 500. Somente service_role chama.';
