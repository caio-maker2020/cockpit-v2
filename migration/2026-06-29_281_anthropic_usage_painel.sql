-- =============================================================================
-- Painel Anthropic API Platform (Caio 2026-06-29)
--
-- Leitura agregada e token-gated para o Vercel Monitor de Capacidade.
-- Depende da mig 280 (public.anthropic_usage_log). Nao expoe prompt, conteudo,
-- imagem/base64, resposta completa ou PII: somente metadados agregados de uso.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.anthropic_usage_periodo(
  p_token text,
  p_inicio date,
  p_fim date
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v jsonb;
  v_ini timestamptz;
  v_fim timestamptz;
  v_dias int;
BEGIN
  IF p_token IS DISTINCT FROM 'salexcap7f3k9q2x' THEN
    RAISE EXCEPTION 'token invalido';
  END IF;

  v_ini := p_inicio::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_fim := (p_fim + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_dias := greatest((p_fim - p_inicio + 1), 1);

  WITH base AS (
    SELECT
      (started_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
      function_name,
      agent_name,
      model,
      input_tokens,
      output_tokens,
      cache_creation_tokens,
      cache_read_tokens,
      image_count,
      estimated_cost_usd,
      status,
      card_id,
      message_id
    FROM public.anthropic_usage_log
    WHERE started_at >= v_ini
      AND started_at < v_fim
  ),
  dias AS (
    SELECT
      dia,
      count(*)::int AS chamadas,
      count(*) FILTER (WHERE status = 'error')::int AS erros,
      sum(input_tokens)::bigint AS tokens_in,
      sum(output_tokens)::bigint AS tokens_out,
      sum(cache_creation_tokens)::bigint AS cache_creation_tokens,
      sum(cache_read_tokens)::bigint AS cache_read_tokens,
      sum(image_count)::bigint AS imagens,
      round(coalesce(sum(estimated_cost_usd), 0)::numeric, 6) AS custo_usd,
      count(*) FILTER (WHERE function_name = 'interpretador-evidencia-foto')::int AS vision_chamadas,
      sum(image_count) FILTER (WHERE function_name = 'interpretador-evidencia-foto')::bigint AS vision_imagens,
      round(coalesce(sum(estimated_cost_usd) FILTER (WHERE function_name = 'interpretador-evidencia-foto'), 0)::numeric, 6) AS vision_custo_usd
    FROM base
    GROUP BY 1
  ),
  funcoes AS (
    SELECT
      function_name,
      agent_name,
      model,
      count(*)::int AS chamadas,
      count(*) FILTER (WHERE status = 'error')::int AS erros,
      sum(input_tokens)::bigint AS tokens_in,
      sum(output_tokens)::bigint AS tokens_out,
      sum(image_count)::bigint AS imagens,
      round(coalesce(sum(estimated_cost_usd), 0)::numeric, 6) AS custo_usd,
      round((coalesce(sum(estimated_cost_usd), 0) / nullif(count(*), 0))::numeric, 6) AS custo_medio_usd
    FROM base
    GROUP BY 1, 2, 3
  ),
  modelos AS (
    SELECT
      model,
      count(*)::int AS chamadas,
      count(*) FILTER (WHERE status = 'error')::int AS erros,
      round(coalesce(sum(estimated_cost_usd), 0)::numeric, 6) AS custo_usd
    FROM base
    GROUP BY 1
  ),
  total AS (
    SELECT
      count(*)::int AS chamadas,
      count(*) FILTER (WHERE status = 'error')::int AS erros,
      count(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS chamadas_sem_custo,
      coalesce(sum(input_tokens), 0)::bigint AS tokens_in,
      coalesce(sum(output_tokens), 0)::bigint AS tokens_out,
      coalesce(sum(cache_creation_tokens), 0)::bigint AS cache_creation_tokens,
      coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read_tokens,
      coalesce(sum(image_count), 0)::bigint AS imagens,
      count(DISTINCT card_id) FILTER (WHERE card_id IS NOT NULL)::int AS cards_com_ia,
      count(DISTINCT message_id) FILTER (WHERE message_id IS NOT NULL)::int AS mensagens_com_ia,
      round(coalesce(sum(estimated_cost_usd), 0)::numeric, 6) AS custo_usd
    FROM base
  )
  SELECT jsonb_build_object(
    'inicio', p_inicio,
    'fim', p_fim,
    'total_chamadas', t.chamadas,
    'total_erros', t.erros,
    'total_chamadas_sem_custo', t.chamadas_sem_custo,
    'total_tokens_in', t.tokens_in,
    'total_tokens_out', t.tokens_out,
    'total_cache_creation_tokens', t.cache_creation_tokens,
    'total_cache_read_tokens', t.cache_read_tokens,
    'total_imagens', t.imagens,
    'total_cards_com_ia', t.cards_com_ia,
    'total_mensagens_com_ia', t.mensagens_com_ia,
    'total_custo_usd', t.custo_usd,
    'media_dia_usd', round((t.custo_usd / v_dias)::numeric, 6),
    'custo_medio_chamada_usd', round((t.custo_usd / nullif(t.chamadas, 0))::numeric, 6),
    'custo_por_imagem_usd', round((t.custo_usd / nullif(t.imagens, 0))::numeric, 6),
    'custo_por_card_usd', round((t.custo_usd / nullif(t.cards_com_ia, 0))::numeric, 6),
    'dias', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'dia', d.dia,
        'chamadas', d.chamadas,
        'erros', d.erros,
        'tokens_in', d.tokens_in,
        'tokens_out', d.tokens_out,
        'cache_creation_tokens', d.cache_creation_tokens,
        'cache_read_tokens', d.cache_read_tokens,
        'imagens', d.imagens,
        'custo_usd', d.custo_usd,
        'vision_chamadas', d.vision_chamadas,
        'vision_imagens', coalesce(d.vision_imagens, 0),
        'vision_custo_usd', d.vision_custo_usd,
        'custo_por_imagem_usd', round((d.custo_usd / nullif(d.imagens, 0))::numeric, 6)
      ) ORDER BY d.dia)
      FROM dias d
    ), '[]'::jsonb),
    'funcoes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'function_name', f.function_name,
        'agent_name', f.agent_name,
        'model', f.model,
        'chamadas', f.chamadas,
        'erros', f.erros,
        'tokens_in', f.tokens_in,
        'tokens_out', f.tokens_out,
        'imagens', f.imagens,
        'custo_usd', f.custo_usd,
        'custo_medio_usd', f.custo_medio_usd,
        'erro_pct', round((100.0 * f.erros / nullif(f.chamadas, 0))::numeric, 2)
      ) ORDER BY f.custo_usd DESC, f.chamadas DESC)
      FROM funcoes f
    ), '[]'::jsonb),
    'modelos', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'model', m.model,
        'chamadas', m.chamadas,
        'erros', m.erros,
        'custo_usd', m.custo_usd
      ) ORDER BY m.custo_usd DESC, m.chamadas DESC)
      FROM modelos m
    ), '[]'::jsonb)
  ) INTO v
  FROM total t;

  RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.anthropic_usage_periodo(text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.anthropic_usage_periodo(text, date, date) TO anon, authenticated;
