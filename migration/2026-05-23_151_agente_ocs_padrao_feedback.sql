-- ============================================================================
-- Cockpit v2 — Feedback loop "operador corrige IA" pra ocs padrão (10/11/19/35)
-- Caio 2026-05-23
--
-- Espelha mig 149 (agente_oc13_feedback) mas pra ocs padrão. Tabela separada
-- pra não acoplar conceitos (oc=13 é caso especial cliente exceção; estas são
-- universais). Mesmas RPCs (explícito + implícito) + view de métricas.
--
-- skill: supabase-postgres-best-practices
--   * RLS + GRANT explícito (memory feedback_rls_grant_antes_de_policy)
--   * security_invoker=on na view (memory feedback_views_publicas_security_invoker)
-- ============================================================================

-- 1. Tabela
CREATE TABLE IF NOT EXISTS public.agente_ocs_padrao_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  codigo_oc_card int NOT NULL,                  -- 10|11|19|35 (oc do card no momento)
  tipo_feedback text NOT NULL CHECK (tipo_feedback IN (
    'sugestao_errada_explicita',                -- operador clicou "IA errou"
    'sugestao_errada_implicita'                 -- operador aprovou proposta != sugerida
  )),
  decisao_ia jsonb NOT NULL,                    -- snapshot do analise_padrao_resultado
  decisao_correta_codigo_ssw int,               -- 21|54|56|41|outro
  motivo_correcao text,
  corrigido_por uuid REFERENCES public.operadores(id),
  corrigido_por_nome text,
  corrigido_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_padrao_card
  ON public.agente_ocs_padrao_feedback (card_id, corrigido_em DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_padrao_codigo
  ON public.agente_ocs_padrao_feedback (codigo_oc_card, tipo_feedback, corrigido_em DESC);

ALTER TABLE public.agente_ocs_padrao_feedback ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON public.agente_ocs_padrao_feedback TO authenticated;
GRANT ALL ON public.agente_ocs_padrao_feedback TO service_role;

DROP POLICY IF EXISTS feedback_padrao_select ON public.agente_ocs_padrao_feedback;
CREATE POLICY feedback_padrao_select ON public.agente_ocs_padrao_feedback
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = agente_ocs_padrao_feedback.card_id
        AND public.card_visivel_pelo_operador_atual(c.assigned_operator_id, c.pagador, c.segmento_codigo)
    )
  );

DROP POLICY IF EXISTS feedback_padrao_insert ON public.agente_ocs_padrao_feedback;
CREATE POLICY feedback_padrao_insert ON public.agente_ocs_padrao_feedback
  FOR INSERT TO authenticated WITH CHECK (false);

COMMENT ON TABLE public.agente_ocs_padrao_feedback IS
  'Feedback loop operador→IA pra ocs padrão (10/11/19/35). Caio 2026-05-23.';


-- 2. RPC explícita (operador autenticado)
CREATE OR REPLACE FUNCTION public.registrar_feedback_ocs_padrao_ia(
  p_card_id uuid,
  p_decisao_correta_codigo_ssw int DEFAULT NULL,
  p_motivo_correcao text DEFAULT NULL
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
  v_motivo_limpo text;
  v_assigned uuid;
  v_pagador text;
  v_segmento text;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Operador não autenticado' USING ERRCODE = '42501';
  END IF;

  v_motivo_limpo := NULLIF(trim(COALESCE(p_motivo_correcao,'')), '');
  IF v_motivo_limpo IS NULL OR length(v_motivo_limpo) < 10 THEN
    RAISE EXCEPTION 'Motivo da correção é obrigatório (mínimo 10 caracteres)' USING ERRCODE = '22023';
  END IF;

  SELECT nome INTO v_nome FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_nome IS NULL THEN v_nome := 'desconhecido'; END IF;

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

  INSERT INTO public.agente_ocs_padrao_feedback (
    card_id, codigo_oc_card, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_codigo_oc, 'sugestao_errada_explicita', v_decisao_ia, p_decisao_correta_codigo_ssw,
    v_motivo_limpo, v_user, v_nome
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

COMMENT ON FUNCTION public.registrar_feedback_ocs_padrao_ia IS
  'Operador registra que IA errou em card oc=10/11/19/35. Caio 2026-05-23.';


-- 3. RPC implícita (service_role — executor)
CREATE OR REPLACE FUNCTION public.registrar_feedback_ocs_padrao_implicito(
  p_card_id uuid,
  p_codigo_aprovado int
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_decisao_ia jsonb;
  v_codigo_oc int;
  v_proposta_destacada int;
BEGIN
  SELECT analise_padrao_resultado, cod_ultima_ocorrencia
    INTO v_decisao_ia, v_codigo_oc
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_codigo_oc NOT IN (10, 11, 19, 35) THEN
    RETURN NULL;
  END IF;

  v_proposta_destacada := (v_decisao_ia->>'proposta_destacada')::int;
  IF v_proposta_destacada IS NULL THEN
    RETURN NULL;
  END IF;

  -- Operador aprovou a mesma proposta da IA → não é feedback
  IF p_codigo_aprovado = v_proposta_destacada THEN
    RETURN NULL;
  END IF;

  -- Idempotência
  IF EXISTS (
    SELECT 1 FROM public.agente_ocs_padrao_feedback
    WHERE card_id = p_card_id AND tipo_feedback = 'sugestao_errada_implicita'
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.agente_ocs_padrao_feedback (
    card_id, codigo_oc_card, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_codigo_oc, 'sugestao_errada_implicita', v_decisao_ia, p_codigo_aprovado,
    NULL, NULL, 'executor (implícito)'
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_feedback_ocs_padrao_implicito(uuid, int) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.registrar_feedback_ocs_padrao_implicito(uuid, int) TO service_role;

COMMENT ON FUNCTION public.registrar_feedback_ocs_padrao_implicito IS
  'Chamada pelo executor quando todo aprovado ≠ proposta sugerida pela IA. Idempotente. Caio 2026-05-23.';


-- 4. View métricas por oc + dia
DROP VIEW IF EXISTS public.v_agente_ocs_padrao_metricas CASCADE;
CREATE VIEW public.v_agente_ocs_padrao_metricas
WITH (security_invoker = on) AS
SELECT
  date_trunc('day', c.analise_padrao_atualizado_em)::date AS dia,
  c.cod_ultima_ocorrencia AS codigo_oc,
  c.responsavel_relacionamento AS operador,
  (c.analise_padrao_resultado->>'proposta_destacada')::int AS proposta_destacada,
  COUNT(*) FILTER (WHERE c.analise_padrao_status='concluida') AS total_sugestoes,
  COUNT(*) FILTER (WHERE f.id IS NOT NULL) AS sugestoes_corrigidas,
  COUNT(*) FILTER (WHERE f.tipo_feedback='sugestao_errada_explicita') AS corrigidas_explicitas,
  COUNT(*) FILTER (WHERE f.tipo_feedback='sugestao_errada_implicita') AS corrigidas_implicitas,
  ROUND(100.0 * (1 - (COUNT(*) FILTER (WHERE f.id IS NOT NULL))::numeric
                       / NULLIF(COUNT(*) FILTER (WHERE c.analise_padrao_status='concluida'), 0)), 1)
    AS pct_acerto_ia
FROM public.cards c
LEFT JOIN public.agente_ocs_padrao_feedback f ON f.card_id = c.id
WHERE c.cod_ultima_ocorrencia IN (10, 11, 19, 35)
  AND c.analise_padrao_status IS NOT NULL
  AND c.analise_padrao_atualizado_em IS NOT NULL
GROUP BY 1, 2, 3, 4
ORDER BY 1 DESC, 2, 3;

GRANT SELECT ON public.v_agente_ocs_padrao_metricas TO authenticated, service_role;

COMMENT ON VIEW public.v_agente_ocs_padrao_metricas IS
  'Métricas diárias do agente-sugere-ocs-padrao por oc × operador. '
  'Alimenta card "🎯 Acerto Agente IA — Ocs Padrão" na aba INDICADORES. Caio 2026-05-23.';
