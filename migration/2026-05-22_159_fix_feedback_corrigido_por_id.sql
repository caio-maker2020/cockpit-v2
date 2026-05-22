-- ============================================================================
-- Cockpit v2 — FIX FK violation no feedback IA (oc=13 + ocs padrão)
-- Caio 2026-05-22
--
-- Bug: as 4 RPCs (registrar_feedback_oc13_ia, registrar_feedback_ocs_padrao_ia,
-- registrar_acerto_oc13_ia, registrar_acerto_ocs_padrao_ia) gravam
-- `corrigido_por = auth.uid()`. Mas a coluna `corrigido_por` referencia
-- `public.operadores(id)`, NÃO `auth.users(id)`.
--
-- Em `operadores`, `id` (PK) é diferente de `user_id` (= auth.uid()).
-- Tentativa de INSERT bate em FK violation:
--   "violates foreign key constraint agente_ocs_padrao_feedback_corrigido_por_fkey"
--   (reportado por Larissa 2026-05-22 ao clicar "IA acertou")
--
-- Fix: resolver `operador_id` a partir de `auth.uid()` antes do INSERT.
-- Aplicar nas 4 RPCs.
--
-- skill: supabase-postgres-best-practices
--   * CREATE OR REPLACE FUNCTION mantém GRANT existente
--   * SECURITY DEFINER + SET search_path = public (não mexer)
--   * Validação: se operador não encontrado, falha explícita 42501
-- ============================================================================

-- 1. registrar_feedback_oc13_ia (mig 149) — corrige FK
CREATE OR REPLACE FUNCTION public.registrar_feedback_oc13_ia(
  p_card_id uuid,
  p_decisao_correta_codigo_ssw int,
  p_motivo_correcao text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_operador_id uuid;
  v_nome text;
  v_id uuid;
  v_decisao_ia jsonb;
  v_tipo_feedback text;
  v_assigned uuid;
  v_pagador text;
  v_segmento text;
  v_motivo_limpo text;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Operador não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT id, nome INTO v_operador_id, v_nome
  FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador % não cadastrado em public.operadores', v_user USING ERRCODE = '42501';
  END IF;

  SELECT assigned_operator_id, pagador, segmento_codigo, analise_oc13_resultado
    INTO v_assigned, v_pagador, v_segmento, v_decisao_ia
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RAISE EXCEPTION 'Card % não tem análise IA oc=13 — feedback inaplicável', p_card_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.card_visivel_pelo_operador_atual(v_assigned, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão' USING ERRCODE = '42501';
  END IF;

  v_motivo_limpo := NULLIF(trim(COALESCE(p_motivo_correcao,'')), '');
  IF v_motivo_limpo IS NOT NULL AND length(v_motivo_limpo) < 10 THEN
    RAISE EXCEPTION 'Motivo da correção precisa ter ao menos 10 caracteres' USING ERRCODE = '22023';
  END IF;

  v_tipo_feedback := CASE
    WHEN v_decisao_ia->>'decisao' = 'autonoma' THEN 'autonoma_errada'
    ELSE 'sugestao_errada_explicita'
  END;

  INSERT INTO public.agente_oc13_feedback (
    card_id, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_tipo_feedback, v_decisao_ia, p_decisao_correta_codigo_ssw,
    v_motivo_limpo, v_operador_id, v_nome
  )
  RETURNING id INTO v_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'FeedbackAgenteOc13', 'operator', v_user::text,
    jsonb_build_object(
      'feedback_id', v_id,
      'tipo_feedback', v_tipo_feedback,
      'decisao_correta_codigo_ssw', p_decisao_correta_codigo_ssw,
      'motivo_correcao', v_motivo_limpo,
      'corrigido_por_nome', v_nome
    )
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.registrar_feedback_oc13_ia(uuid, int, text) TO authenticated;


-- 2. registrar_feedback_ocs_padrao_ia (mig 151) — corrige FK
-- DROP necessário porque mig 151 declarou DEFAULT em parâmetros
DROP FUNCTION IF EXISTS public.registrar_feedback_ocs_padrao_ia(uuid, int, text);
CREATE OR REPLACE FUNCTION public.registrar_feedback_ocs_padrao_ia(
  p_card_id uuid,
  p_decisao_correta_codigo_ssw int,
  p_motivo_correcao text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_operador_id uuid;
  v_nome text;
  v_id uuid;
  v_decisao_ia jsonb;
  v_codigo_oc int;
  v_assigned uuid;
  v_pagador text;
  v_segmento text;
  v_motivo_limpo text;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Operador não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT id, nome INTO v_operador_id, v_nome
  FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador % não cadastrado em public.operadores', v_user USING ERRCODE = '42501';
  END IF;

  SELECT assigned_operator_id, pagador, segmento_codigo, analise_padrao_resultado, cod_ultima_ocorrencia
    INTO v_assigned, v_pagador, v_segmento, v_decisao_ia, v_codigo_oc
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RAISE EXCEPTION 'Card % não tem análise IA padrão — feedback inaplicável', p_card_id USING ERRCODE = 'P0002';
  END IF;

  IF v_codigo_oc NOT IN (10, 11, 19, 35) THEN
    RAISE EXCEPTION 'Card % oc=% fora do escopo do agente padrão', p_card_id, v_codigo_oc USING ERRCODE = '22023';
  END IF;

  IF NOT public.card_visivel_pelo_operador_atual(v_assigned, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão pra registrar feedback neste card' USING ERRCODE = '42501';
  END IF;

  v_motivo_limpo := NULLIF(trim(COALESCE(p_motivo_correcao,'')), '');
  IF v_motivo_limpo IS NOT NULL AND length(v_motivo_limpo) < 10 THEN
    RAISE EXCEPTION 'Motivo da correção precisa ter ao menos 10 caracteres' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.agente_ocs_padrao_feedback (
    card_id, codigo_oc_card, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_codigo_oc, 'sugestao_errada_explicita', v_decisao_ia, p_decisao_correta_codigo_ssw,
    v_motivo_limpo, v_operador_id, v_nome
  )
  RETURNING id INTO v_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'FeedbackAgenteOcsPadrao', 'operator', v_user::text,
    jsonb_build_object(
      'feedback_id', v_id,
      'codigo_oc_card', v_codigo_oc,
      'tipo_feedback', 'sugestao_errada_explicita',
      'decisao_correta_codigo_ssw', p_decisao_correta_codigo_ssw,
      'motivo_correcao', v_motivo_limpo,
      'corrigido_por_nome', v_nome
    )
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.registrar_feedback_ocs_padrao_ia(uuid, int, text) TO authenticated;


-- 3. registrar_acerto_oc13_ia (mig 158) — corrige FK
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
  v_operador_id uuid;
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

  SELECT id, nome INTO v_operador_id, v_nome
  FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador % não cadastrado em public.operadores', v_user USING ERRCODE = '42501';
  END IF;

  SELECT assigned_operator_id, pagador, segmento_codigo, analise_oc13_resultado
    INTO v_assigned, v_pagador, v_segmento, v_decisao_ia
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RAISE EXCEPTION 'Card % não tem análise IA oc=13', p_card_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.card_visivel_pelo_operador_atual(v_assigned, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão' USING ERRCODE = '42501';
  END IF;

  v_tipo_feedback := CASE
    WHEN v_decisao_ia->>'decisao' = 'autonoma' THEN 'autonoma_certa'
    ELSE 'sugestao_certa_explicita'
  END;

  INSERT INTO public.agente_oc13_feedback (
    card_id, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_tipo_feedback, v_decisao_ia, NULL,
    NULLIF(trim(COALESCE(p_observacao,'')), ''), v_operador_id, v_nome
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


-- 4. registrar_acerto_ocs_padrao_ia (mig 158) — corrige FK
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
  v_operador_id uuid;
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

  SELECT id, nome INTO v_operador_id, v_nome
  FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador % não cadastrado em public.operadores', v_user USING ERRCODE = '42501';
  END IF;

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
    NULLIF(trim(COALESCE(p_observacao,'')), ''), v_operador_id, v_nome
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
