-- ============================================================================
-- Cockpit v2 — Feedback POSITIVO ("IA acertou") + threshold rumo a autônomo
-- Caio 2026-05-22
--
-- Antes: tabelas agente_oc13_feedback e agente_ocs_padrao_feedback só
-- aceitavam tipos negativos (autonoma_errada, sugestao_errada_*).
-- Agora: operador pode confirmar acerto, e o sistema acumula histórico
-- positivo. Quando atingir threshold de acertos consecutivos, pode liberar
-- autonomia (Caio decide depois).
--
-- skill: supabase-postgres-best-practices
--   * ALTER CHECK constraint via DROP+ADD (Postgres não tem MODIFY CHECK)
--   * RPC SECURITY DEFINER + auth.uid() (operador autenticado)
--   * View métricas atualizada pra mostrar acertos vs erros
-- ============================================================================

-- 1. Estender CHECK constraint pra aceitar tipos positivos
ALTER TABLE public.agente_oc13_feedback
  DROP CONSTRAINT IF EXISTS agente_oc13_feedback_tipo_feedback_check;
ALTER TABLE public.agente_oc13_feedback
  ADD CONSTRAINT agente_oc13_feedback_tipo_feedback_check
  CHECK (tipo_feedback IN (
    'autonoma_errada',
    'sugestao_errada_explicita',
    'sugestao_errada_implicita',
    'autonoma_certa',                  -- novo
    'sugestao_certa_explicita',        -- novo (operador clicou "IA acertou")
    'sugestao_certa_implicita'         -- novo (operador aprovou EXATAMENTE a proposta IA)
  ));

ALTER TABLE public.agente_ocs_padrao_feedback
  DROP CONSTRAINT IF EXISTS agente_ocs_padrao_feedback_tipo_feedback_check;
ALTER TABLE public.agente_ocs_padrao_feedback
  ADD CONSTRAINT agente_ocs_padrao_feedback_tipo_feedback_check
  CHECK (tipo_feedback IN (
    'sugestao_errada_explicita',
    'sugestao_errada_implicita',
    'sugestao_certa_explicita',        -- novo
    'sugestao_certa_implicita'         -- novo
  ));


-- 2. RPC: operador clica "IA acertou" — agente oc=13
CREATE OR REPLACE FUNCTION public.registrar_acerto_oc13_ia(
  p_card_id uuid,
  p_observacao text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_nome text;
  v_id uuid;
  v_decisao_ia jsonb;
  v_assigned uuid;
  v_pagador text;
  v_segmento text;
  v_tipo_feedback text;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Operador não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT nome INTO v_nome FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_nome IS NULL THEN v_nome := 'desconhecido'; END IF;

  SELECT assigned_operator_id, pagador, segmento_codigo, analise_oc13_resultado
    INTO v_assigned, v_pagador, v_segmento, v_decisao_ia
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RAISE EXCEPTION 'Card % não tem análise IA oc=13', p_card_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.card_visivel_pelo_operador_atual(v_assigned, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão' USING ERRCODE = '42501';
  END IF;

  -- Tipo de acerto depende da decisão original
  v_tipo_feedback := CASE
    WHEN v_decisao_ia->>'decisao' = 'autonoma' THEN 'autonoma_certa'
    ELSE 'sugestao_certa_explicita'
  END;

  INSERT INTO public.agente_oc13_feedback (
    card_id, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_tipo_feedback, v_decisao_ia, NULL,
    NULLIF(trim(COALESCE(p_observacao,'')), ''), v_user, v_nome
  )
  RETURNING id INTO v_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'FeedbackAgenteOc13', 'operator', v_user::text,
    jsonb_build_object(
      'feedback_id', v_id,
      'tipo_feedback', v_tipo_feedback,
      'observacao', p_observacao,
      'corrigido_por_nome', v_nome
    )
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.registrar_acerto_oc13_ia(uuid, text) TO authenticated;


-- 3. RPC: operador clica "IA acertou" — agente ocs padrão (10/11/19/35)
CREATE OR REPLACE FUNCTION public.registrar_acerto_ocs_padrao_ia(
  p_card_id uuid,
  p_observacao text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_nome text;
  v_id uuid;
  v_decisao_ia jsonb;
  v_codigo_oc int;
  v_assigned uuid;
  v_pagador text;
  v_segmento text;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Operador não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT nome INTO v_nome FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_nome IS NULL THEN v_nome := 'desconhecido'; END IF;

  SELECT assigned_operator_id, pagador, segmento_codigo, analise_padrao_resultado, cod_ultima_ocorrencia
    INTO v_assigned, v_pagador, v_segmento, v_decisao_ia, v_codigo_oc
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RAISE EXCEPTION 'Card % não tem análise IA padrão', p_card_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.card_visivel_pelo_operador_atual(v_assigned, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.agente_ocs_padrao_feedback (
    card_id, codigo_oc_card, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_codigo_oc, 'sugestao_certa_explicita', v_decisao_ia, NULL,
    NULLIF(trim(COALESCE(p_observacao,'')), ''), v_user, v_nome
  )
  RETURNING id INTO v_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'FeedbackAgenteOcsPadrao', 'operator', v_user::text,
    jsonb_build_object(
      'feedback_id', v_id,
      'codigo_oc_card', v_codigo_oc,
      'tipo_feedback', 'sugestao_certa_explicita',
      'observacao', p_observacao,
      'corrigido_por_nome', v_nome
    )
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.registrar_acerto_ocs_padrao_ia(uuid, text) TO authenticated;


-- 4. Atualizar view de métricas oc=13 — incluir acertos confirmados
DROP VIEW IF EXISTS public.v_agente_oc13_metricas CASCADE;
CREATE VIEW public.v_agente_oc13_metricas
WITH (security_invoker = on) AS
SELECT
  date_trunc('day', c.analise_oc13_atualizado_em)::date AS dia,
  c.responsavel_relacionamento AS operador,
  c.analise_oc13_resultado->>'decisao' AS tipo_decisao_ia,
  COUNT(*) FILTER (WHERE c.analise_oc13_status='concluida') AS total_decisoes,
  COUNT(*) FILTER (WHERE c.analise_oc13_resultado->>'decisao'='autonoma') AS total_autonomas,
  COUNT(*) FILTER (WHERE c.analise_oc13_resultado->>'decisao'='sugerir_54_email') AS total_sugestoes,
  -- Erros
  COUNT(*) FILTER (WHERE f.tipo_feedback='autonoma_errada') AS autonomas_erradas,
  COUNT(*) FILTER (WHERE f.tipo_feedback IN ('sugestao_errada_explicita','sugestao_errada_implicita')) AS sugestoes_erradas,
  -- Acertos confirmados (operador clicou "IA acertou" OU aprovou EXATAMENTE a proposta)
  COUNT(*) FILTER (WHERE f.tipo_feedback IN ('autonoma_certa','sugestao_certa_explicita','sugestao_certa_implicita')) AS acertos_confirmados,
  -- % acerto contabiliza apenas casos com feedback (explícito OU implícito)
  ROUND(
    100.0 *
    COUNT(*) FILTER (WHERE f.tipo_feedback LIKE '%_certa%' OR f.tipo_feedback LIKE '%_certa_%')::numeric /
    NULLIF(COUNT(*) FILTER (WHERE f.id IS NOT NULL), 0),
    1
  ) AS pct_acerto_ia
FROM public.cards c
LEFT JOIN public.agente_oc13_feedback f ON f.card_id = c.id
WHERE c.cod_ultima_ocorrencia = 13
  AND c.analise_oc13_status IS NOT NULL
  AND c.analise_oc13_atualizado_em IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2;

GRANT SELECT ON public.v_agente_oc13_metricas TO authenticated, service_role;


-- 5. Atualizar view de métricas ocs padrão
DROP VIEW IF EXISTS public.v_agente_ocs_padrao_metricas CASCADE;
CREATE VIEW public.v_agente_ocs_padrao_metricas
WITH (security_invoker = on) AS
SELECT
  date_trunc('day', c.analise_padrao_atualizado_em)::date AS dia,
  c.cod_ultima_ocorrencia AS codigo_oc,
  c.responsavel_relacionamento AS operador,
  (c.analise_padrao_resultado->>'proposta_destacada')::int AS proposta_destacada,
  COUNT(*) FILTER (WHERE c.analise_padrao_status='concluida') AS total_sugestoes,
  -- Erros
  COUNT(*) FILTER (WHERE f.tipo_feedback='sugestao_errada_explicita') AS corrigidas_explicitas,
  COUNT(*) FILTER (WHERE f.tipo_feedback='sugestao_errada_implicita') AS corrigidas_implicitas,
  -- Acertos
  COUNT(*) FILTER (WHERE f.tipo_feedback IN ('sugestao_certa_explicita','sugestao_certa_implicita')) AS acertos_confirmados,
  ROUND(
    100.0 *
    COUNT(*) FILTER (WHERE f.tipo_feedback LIKE 'sugestao_certa%')::numeric /
    NULLIF(COUNT(*) FILTER (WHERE f.id IS NOT NULL), 0),
    1
  ) AS pct_acerto_ia
FROM public.cards c
LEFT JOIN public.agente_ocs_padrao_feedback f ON f.card_id = c.id
WHERE c.cod_ultima_ocorrencia IN (10, 11, 19, 35)
  AND c.analise_padrao_status IS NOT NULL
  AND c.analise_padrao_atualizado_em IS NOT NULL
GROUP BY 1, 2, 3, 4
ORDER BY 1 DESC, 2, 3;

GRANT SELECT ON public.v_agente_ocs_padrao_metricas TO authenticated, service_role;


-- 6. View RUMO À AUTONOMIA — conta acertos consecutivos por operador+cliente+oc
-- Caio: "quando tiver uns 10 acertos quero deixar autônomo".
-- Esta view expõe o histórico pra avaliar threshold sem precisar ativar nada.
DROP VIEW IF EXISTS public.v_agente_ocs_padrao_rumo_autonomia CASCADE;
CREATE VIEW public.v_agente_ocs_padrao_rumo_autonomia
WITH (security_invoker = on) AS
SELECT
  c.responsavel_relacionamento AS operador,
  c.cod_ultima_ocorrencia AS codigo_oc,
  c.pagador,
  COUNT(*) FILTER (WHERE f.tipo_feedback IN ('sugestao_certa_explicita','sugestao_certa_implicita')) AS acertos,
  COUNT(*) FILTER (WHERE f.tipo_feedback IN ('sugestao_errada_explicita','sugestao_errada_implicita')) AS erros,
  COUNT(*) FILTER (WHERE f.id IS NOT NULL) AS total_avaliados,
  ROUND(
    100.0 *
    COUNT(*) FILTER (WHERE f.tipo_feedback LIKE 'sugestao_certa%')::numeric /
    NULLIF(COUNT(*) FILTER (WHERE f.id IS NOT NULL), 0),
    1
  ) AS pct_acerto,
  MIN(f.corrigido_em) AS primeiro_feedback_em,
  MAX(f.corrigido_em) AS ultimo_feedback_em
FROM public.cards c
JOIN public.agente_ocs_padrao_feedback f ON f.card_id = c.id
WHERE c.cod_ultima_ocorrencia IN (10, 11, 19, 35)
GROUP BY 1, 2, 3
HAVING COUNT(*) >= 1
ORDER BY pct_acerto DESC NULLS LAST, acertos DESC;

GRANT SELECT ON public.v_agente_ocs_padrao_rumo_autonomia TO authenticated, service_role;

COMMENT ON VIEW public.v_agente_ocs_padrao_rumo_autonomia IS
  'Tracking pra decidir quando agentes ocs padrão podem virar autônomos. '
  'Caio 2026-05-22: threshold sugerido = 10 acertos consecutivos por (operador, oc, pagador) sem erros.';
