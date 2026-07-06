-- ============================================================================
-- Cockpit v2 — mig 280: anthropic_usage_log + anthropic_pricing
-- Data: 2026-06-29
--
-- ⚠️ NÃO APLICADA AINDA. Decisão Caio 2026-06-29: instrumentação primeiro,
--    sem deploy/aplicação em produção até validação. Branch:
--    feat/anthropic-usage-only. Ver memória
--    feedback_instrumentar_custo_anthropic_antes_de_otimizar.
--
-- Objetivo: medir CUSTO REAL por chamada à Anthropic API Platform. Hoje nenhuma
-- tabela guarda tokens/custo (agent_runs.tokens_* = 100% NULL; completeJson
-- descartava usage; interpretador-evidencia-foto faz fetch direto e não logava).
--
-- Privacidade: SÓ metadados de uso/custo. NUNCA prompt, conteúdo de e-mail,
-- imagem/base64, resposta completa ou PII.
--
-- Escala: ~3-5k chamadas/mês → ~50-100k linhas/ano. NÃO particionar agora
-- (regra Supabase: particionar só >100M linhas). Se crescer, BRIN(started_at).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tabela de preço (source-of-truth pra RECOMPUTAR custo via SQL). USD por
-- milhão de tokens (MTok). cache_write usa TTL 5min (1.25x do input).
-- Fonte: skill claude-api (cache 2026-06-04).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.anthropic_pricing (
  model                  text PRIMARY KEY,
  input_usd_mtok         numeric NOT NULL,
  output_usd_mtok        numeric NOT NULL,
  cache_read_usd_mtok    numeric NOT NULL,
  cache_write5m_usd_mtok numeric NOT NULL,
  atualizado_em          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.anthropic_pricing
  (model, input_usd_mtok, output_usd_mtok, cache_read_usd_mtok, cache_write5m_usd_mtok)
VALUES
  ('claude-sonnet-4-6', 3, 15, 0.30, 3.75),
  ('claude-haiku-4-5',  1,  5, 0.10, 1.25),
  ('claude-opus-4-7',   5, 25, 0.50, 6.25)
ON CONFLICT (model) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Log append-only de uso/custo por CHAMADA (attempt) à Anthropic.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.anthropic_usage_log (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  function_name         text NOT NULL,
  agent_name            text,
  card_id               uuid,
  message_id            uuid,
  model                 text NOT NULL,
  input_tokens          int NOT NULL DEFAULT 0,
  output_tokens         int NOT NULL DEFAULT 0,
  cache_creation_tokens int NOT NULL DEFAULT 0,
  cache_read_tokens     int NOT NULL DEFAULT 0,
  image_count           int NOT NULL DEFAULT 0,
  estimated_cost_usd    numeric(12, 6),
  status                text NOT NULL DEFAULT 'success',   -- success | error
  attempt               int NOT NULL DEFAULT 1,            -- 1 = 1ª chamada; 2 = retry (custo separado)
  request_id            text,
  started_at            timestamptz NOT NULL,
  finished_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.anthropic_usage_log IS
  'Append-only: 1 linha por chamada (attempt) à Anthropic API Platform. SÓ metadados de uso/custo — nunca prompt/conteúdo/PII. estimated_cost_usd derivado de anthropic_pricing. Gravado best-effort pelo backend sob flag ANTHROPIC_USAGE_LOG_ENABLED (default OFF). Retries = linhas separadas (mesma chamada lógica, attempt incremental) pra não esconder custo dobrado. status=error grava tokens 0 (erro HTTP ou falha antes de parsear).';

-- Agregação por função/dia, por modelo/dia, por card (ROI)
CREATE INDEX IF NOT EXISTS idx_anthropic_usage_func_time
  ON public.anthropic_usage_log (function_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_anthropic_usage_model_time
  ON public.anthropic_usage_log (model, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_anthropic_usage_card
  ON public.anthropic_usage_log (card_id)
  WHERE card_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Append-only: trigger bloqueia UPDATE/DELETE (vale inclusive p/ service_role,
-- que bypassa RLS mas NÃO triggers). Rollback do baseline = DROP TABLE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anthropic_usage_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'anthropic_usage_log é append-only (% bloqueado)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_anthropic_usage_log_immutable ON public.anthropic_usage_log;
CREATE TRIGGER trg_anthropic_usage_log_immutable
  BEFORE UPDATE OR DELETE ON public.anthropic_usage_log
  FOR EACH ROW EXECUTE FUNCTION public.anthropic_usage_log_immutable();

-- ---------------------------------------------------------------------------
-- RLS — só gestor lê; service_role insere (bypassa RLS).
-- GRANT antes de POLICY (feedback_rls_grant_antes_de_policy).
-- ---------------------------------------------------------------------------
ALTER TABLE public.anthropic_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anthropic_pricing   ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.anthropic_usage_log TO authenticated;
GRANT INSERT ON public.anthropic_usage_log TO service_role;
GRANT SELECT ON public.anthropic_pricing   TO authenticated;

CREATE POLICY anthropic_usage_log_select_gestor
  ON public.anthropic_usage_log
  FOR SELECT TO authenticated
  USING (public.current_operador_papel() = 'gestor');

CREATE POLICY anthropic_pricing_select_auth
  ON public.anthropic_pricing
  FOR SELECT TO authenticated
  USING (true);

-- service_role bypassa RLS por padrão (backend grava por essa role).

-- ---------------------------------------------------------------------------
-- Views de leitura (ROI). security_invoker=true → herdam a RLS da tabela base
-- (só gestor lê), em vez de rodar como o owner e furar o RLS.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_anthropic_usage_diario
  WITH (security_invoker = true) AS
SELECT
  started_at::date                                   AS dia,
  model,
  count(*)                                           AS chamadas,
  count(*) FILTER (WHERE status = 'error')           AS erros,
  sum(input_tokens)                                  AS tokens_in,
  sum(output_tokens)                                 AS tokens_out,
  sum(cache_creation_tokens)                         AS cache_creation_tokens,
  sum(cache_read_tokens)                             AS cache_read_tokens,
  sum(image_count)                                   AS imagens,
  round(sum(estimated_cost_usd)::numeric, 4)         AS custo_usd
FROM public.anthropic_usage_log
GROUP BY 1, 2;

CREATE OR REPLACE VIEW public.v_anthropic_usage_por_funcao
  WITH (security_invoker = true) AS
SELECT
  function_name,
  agent_name,
  model,
  count(*)                                           AS chamadas,
  count(*) FILTER (WHERE status = 'error')           AS erros,
  sum(input_tokens)                                  AS tokens_in,
  sum(output_tokens)                                 AS tokens_out,
  round(sum(estimated_cost_usd)::numeric, 4)         AS custo_usd,
  round(avg(estimated_cost_usd)::numeric, 6)         AS custo_medio_usd
FROM public.anthropic_usage_log
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW public.v_anthropic_usage_vision
  WITH (security_invoker = true) AS
SELECT
  started_at::date                                   AS dia,
  count(*)                                           AS chamadas,
  count(*) FILTER (WHERE status = 'error')           AS erros,
  sum(image_count)                                   AS imagens,
  round(avg(image_count)::numeric, 2)                AS imagens_por_chamada,
  sum(input_tokens)                                  AS tokens_in,
  sum(output_tokens)                                 AS tokens_out,
  round(sum(estimated_cost_usd)::numeric, 4)         AS custo_usd,
  round((sum(estimated_cost_usd) / NULLIF(sum(image_count), 0))::numeric, 6) AS custo_por_imagem_usd
FROM public.anthropic_usage_log
WHERE function_name = 'interpretador-evidencia-foto'
GROUP BY 1;

CREATE OR REPLACE VIEW public.v_anthropic_usage_erros
  WITH (security_invoker = true) AS
SELECT
  started_at::date                                   AS dia,
  function_name,
  agent_name,
  model,
  attempt,
  count(*)                                           AS erros,
  max(started_at)                                    AS ultimo_erro
FROM public.anthropic_usage_log
WHERE status = 'error'
GROUP BY 1, 2, 3, 4, 5;

GRANT SELECT ON public.v_anthropic_usage_diario     TO authenticated;
GRANT SELECT ON public.v_anthropic_usage_por_funcao TO authenticated;
GRANT SELECT ON public.v_anthropic_usage_vision     TO authenticated;
GRANT SELECT ON public.v_anthropic_usage_erros      TO authenticated;
