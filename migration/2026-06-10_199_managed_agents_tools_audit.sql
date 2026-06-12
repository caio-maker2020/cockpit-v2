-- ============================================================================
-- Cockpit v2 — Auditoria das chamadas dos Managed Agents externos
-- Data: 2026-06-10
--
-- Contexto: 2 Managed Agents na cloud da Anthropic (criados 2026-06-10):
--   - agent_01UDEQ5BDEUAr8Qw49mPnnHJ → Triagem Noturna
--   - agent_01XjV7YMNujG2tkQw5WTfTYL → Aprendizado Continuo
--
-- Eles chamam a edge function `managed-agent-tools` pra executar 4 tools:
--   query_cockpit, insert_learning_log, send_digest_email, propose_prompt_diff
--
-- Toda chamada precisa ser auditada (LGPD/operacional). Tabela
-- `managed_agent_tool_calls` registra tudo: qual agent, qual tool, payload,
-- resposta, erro, duração. Edge function escreve sempre, mesmo em falha.
--
-- IMPORTANTE: a edge function valida HMAC do header X-Tool-Signature
-- (segredo compartilhado), NÃO usa JWT. Auth é via secret + agent_id
-- whitelist hard-coded.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.managed_agent_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- identidade
  agent_id text NOT NULL,           -- ex: agent_01UDEQ5BDEUAr8Qw49mPnnHJ
  agent_nome text NOT NULL,         -- 'triagem-noturna' | 'aprendizado-continuo'
  tool_name text NOT NULL
    CHECK (tool_name IN (
      'query_cockpit',
      'insert_learning_log',
      'send_digest_email',
      'propose_prompt_diff'
    )),

  -- session/message ids da Anthropic (pra correlacionar)
  managed_session_id text,
  managed_message_id text,

  -- payload
  request_payload jsonb NOT NULL,
  response_payload jsonb,
  status text NOT NULL
    CHECK (status IN ('success', 'error', 'rejected_validation', 'rejected_auth')),
  error_message text,

  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.managed_agent_tool_calls IS
  'Auditoria de toda chamada de tool feita pelos Managed Agents externos (Triagem Noturna + Aprendizado Contínuo). Edge function managed-agent-tools insere aqui sempre — sucesso, erro, validação rejeitada, auth rejeitada.';

CREATE INDEX IF NOT EXISTS idx_mat_agent_data
  ON public.managed_agent_tool_calls(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mat_tool_status
  ON public.managed_agent_tool_calls(tool_name, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mat_falhas
  ON public.managed_agent_tool_calls(created_at DESC)
  WHERE status <> 'success';

-- RLS: só gestor lê. Edge function usa service_role (bypassa RLS).
ALTER TABLE public.managed_agent_tool_calls ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.managed_agent_tool_calls TO authenticated;
GRANT INSERT ON public.managed_agent_tool_calls TO service_role;

CREATE POLICY mat_select_gestor
  ON public.managed_agent_tool_calls
  FOR SELECT
  TO authenticated
  USING (public.current_operador_papel() = 'gestor');

-- ============================================================================
-- View pra observabilidade rápida
-- ============================================================================

CREATE OR REPLACE VIEW public.v_managed_agents_health
WITH (security_invoker = on)
AS
SELECT
  agent_nome,
  tool_name,
  count(*) AS chamadas_24h,
  count(*) FILTER (WHERE status = 'success') AS sucesso_24h,
  count(*) FILTER (WHERE status <> 'success') AS falhas_24h,
  ROUND(100.0 * count(*) FILTER (WHERE status = 'success') / NULLIF(count(*), 0), 1) AS success_pct,
  ROUND(AVG(duration_ms)::numeric, 0) AS avg_ms,
  MAX(created_at) AS ultima_chamada
FROM public.managed_agent_tool_calls
WHERE created_at > now() - interval '24 hours'
GROUP BY agent_nome, tool_name
ORDER BY agent_nome, tool_name;

COMMENT ON VIEW public.v_managed_agents_health IS
  'Saúde das chamadas de tools dos Managed Agents nas últimas 24h. Gestor consulta pra debugar.';

GRANT SELECT ON public.v_managed_agents_health TO authenticated;

-- ============================================================================
-- Função helper pra edge function validar SELECT-only
-- (defesa em profundidade — edge function também valida)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.validar_sql_readonly(p_sql text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_normalizado text;
BEGIN
  -- Normaliza: lowercase + remove comentários + remove espaços excessivos
  v_normalizado := lower(regexp_replace(p_sql, '\s+', ' ', 'g'));
  v_normalizado := regexp_replace(v_normalizado, '--[^\n]*', '', 'g');
  v_normalizado := regexp_replace(v_normalizado, '/\*.*?\*/', '', 'g');
  v_normalizado := trim(v_normalizado);

  -- Deve começar com SELECT ou WITH
  IF v_normalizado !~ '^(select|with)\s' THEN
    RETURN false;
  END IF;

  -- Não pode conter comandos de escrita
  IF v_normalizado ~ '\m(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy)\m' THEN
    RETURN false;
  END IF;

  -- Não pode conter chamadas de função SECURITY DEFINER perigosas
  IF v_normalizado ~ '\m(pg_terminate|pg_reload|pg_cancel|set_config|set\s+role|reset\s+role)\m' THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.validar_sql_readonly IS
  'Defesa em profundidade. Edge function managed-agent-tools chama isso antes de rodar query_cockpit. Retorna true só se SQL é SELECT/WITH puro, sem comandos de escrita ou funções perigosas.';
