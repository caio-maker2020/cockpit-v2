-- ============================================================================
-- Cockpit v2 — Feedback loop "operador corrige IA" (agente-oc13-autonomo)
-- Caio 2026-05-22
--
-- Quando operador discorda da decisão do agente IA (autônoma errada OU sugestão
-- errada), registra feedback explícito (botão "IA errou") OU implícito (operador
-- aprovou proposta diferente da sugerida). Métricas alimentam indicador novo
-- "🎯 Acerto Agente IA oc=13" pra Caio ajustar prompt periodicamente.
--
-- Sem re-treino automático — feedback é manual.
--
-- skill: supabase-postgres-best-practices
--   * RLS habilitada + policy reusa card_visivel_pelo_operador_atual
--   * GRANT explícito (memory feedback_rls_grant_antes_de_policy)
--   * view com security_invoker=on (memory feedback_views_publicas_security_invoker)
-- ============================================================================

-- 1. Tabela agente_oc13_feedback
CREATE TABLE IF NOT EXISTS public.agente_oc13_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  tipo_feedback text NOT NULL CHECK (tipo_feedback IN (
    'autonoma_errada',
    'sugestao_errada_explicita',
    'sugestao_errada_implicita'
  )),
  decisao_ia jsonb NOT NULL,
  decisao_correta_codigo_ssw int,
  motivo_correcao text,
  corrigido_por uuid REFERENCES public.operadores(id),
  corrigido_por_nome text,
  corrigido_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_oc13_card
  ON public.agente_oc13_feedback (card_id, corrigido_em DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_oc13_tipo
  ON public.agente_oc13_feedback (tipo_feedback, corrigido_em DESC);

ALTER TABLE public.agente_oc13_feedback ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON public.agente_oc13_feedback TO authenticated;
GRANT ALL ON public.agente_oc13_feedback TO service_role;

DROP POLICY IF EXISTS feedback_oc13_select ON public.agente_oc13_feedback;
CREATE POLICY feedback_oc13_select ON public.agente_oc13_feedback
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = agente_oc13_feedback.card_id
        AND public.card_visivel_pelo_operador_atual(c.assigned_operator_id, c.pagador, c.segmento_codigo)
    )
  );

-- INSERT controlado: só via RPC (operador) ou service_role (implícito do executor)
DROP POLICY IF EXISTS feedback_oc13_insert ON public.agente_oc13_feedback;
CREATE POLICY feedback_oc13_insert ON public.agente_oc13_feedback
  FOR INSERT TO authenticated WITH CHECK (false); -- bloqueia INSERT direto; só via RPC SECURITY DEFINER

COMMENT ON TABLE public.agente_oc13_feedback IS
  'Feedback loop operador→IA oc=13. Tipo: autonoma_errada (botão), '
  'sugestao_errada_explicita (botão), sugestao_errada_implicita (operador aprovou ≠ sugerido). '
  'Caio 2026-05-22.';


-- 2. RPC registrar_feedback_oc13_ia (autenticada — operador)
CREATE OR REPLACE FUNCTION public.registrar_feedback_oc13_ia(
  p_card_id uuid,
  p_tipo_feedback text,
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
  v_motivo_limpo text;
  v_assigned uuid;
  v_pagador text;
  v_segmento text;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Operador não autenticado' USING ERRCODE = '42501';
  END IF;

  IF p_tipo_feedback NOT IN ('autonoma_errada','sugestao_errada_explicita') THEN
    RAISE EXCEPTION 'tipo_feedback inválido: % (operador só envia autonoma_errada ou sugestao_errada_explicita)', p_tipo_feedback;
  END IF;

  v_motivo_limpo := NULLIF(trim(COALESCE(p_motivo_correcao,'')), '');
  IF v_motivo_limpo IS NULL OR length(v_motivo_limpo) < 10 THEN
    RAISE EXCEPTION 'Motivo da correção é obrigatório (mínimo 10 caracteres)' USING ERRCODE = '22023';
  END IF;

  SELECT nome INTO v_nome FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_nome IS NULL THEN v_nome := 'desconhecido'; END IF;

  SELECT assigned_operator_id, pagador, segmento_codigo, analise_oc13_resultado
    INTO v_assigned, v_pagador, v_segmento, v_decisao_ia
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RAISE EXCEPTION 'Card % não tem análise IA oc=13 — feedback inaplicável', p_card_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.card_visivel_pelo_operador_atual(v_assigned, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão pra registrar feedback neste card' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.agente_oc13_feedback (
    card_id, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, p_tipo_feedback, v_decisao_ia, p_decisao_correta_codigo_ssw,
    v_motivo_limpo, v_user, v_nome
  )
  RETURNING id INTO v_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'FeedbackAgenteOc13', 'operator', v_user::text,
    jsonb_build_object(
      'feedback_id', v_id,
      'tipo_feedback', p_tipo_feedback,
      'decisao_correta_codigo_ssw', p_decisao_correta_codigo_ssw,
      'motivo_correcao', v_motivo_limpo,
      'corrigido_por_nome', v_nome
    )
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.registrar_feedback_oc13_ia(uuid, text, int, text) TO authenticated;

COMMENT ON FUNCTION public.registrar_feedback_oc13_ia IS
  'Operador registra que IA errou (botão "IA errou" no banner). Caio 2026-05-22.';


-- 3. RPC registrar_feedback_oc13_implicito (service_role — executor)
CREATE OR REPLACE FUNCTION public.registrar_feedback_oc13_implicito(
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
  v_decisao_tipo text;
BEGIN
  SELECT analise_oc13_resultado INTO v_decisao_ia
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RETURN NULL;
  END IF;

  v_decisao_tipo := v_decisao_ia->>'decisao';

  -- Só grava feedback implícito se IA sugeriu 54+email mas operador aprovou outra
  IF v_decisao_tipo <> 'sugerir_54_email' THEN
    RETURN NULL;
  END IF;

  IF p_codigo_aprovado = 54 THEN
    RETURN NULL;
  END IF;

  -- Idempotência: não registrar duplicado
  IF EXISTS (
    SELECT 1 FROM public.agente_oc13_feedback
    WHERE card_id = p_card_id AND tipo_feedback = 'sugestao_errada_implicita'
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.agente_oc13_feedback (
    card_id, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, 'sugestao_errada_implicita', v_decisao_ia, p_codigo_aprovado,
    NULL, NULL, 'executor (implícito)'
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_feedback_oc13_implicito(uuid, int) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.registrar_feedback_oc13_implicito(uuid, int) TO service_role;

COMMENT ON FUNCTION public.registrar_feedback_oc13_implicito IS
  'Chamada pelo executor quando todo aprovado ≠ sugestão IA. Idempotente. Caio 2026-05-22.';


-- 4. View métricas (security_invoker=on)
DROP VIEW IF EXISTS public.v_agente_oc13_metricas CASCADE;
CREATE VIEW public.v_agente_oc13_metricas
WITH (security_invoker = on) AS
SELECT
  date_trunc('day', c.analise_oc13_atualizado_em)::date AS dia,
  c.responsavel_relacionamento AS operador,
  c.analise_oc13_resultado->>'decisao' AS tipo_decisao_ia,
  COUNT(*) FILTER (WHERE c.analise_oc13_status='concluida') AS total_decisoes,
  COUNT(*) FILTER (WHERE c.analise_oc13_resultado->>'decisao'='autonoma') AS total_autonomas,
  COUNT(*) FILTER (WHERE f.tipo_feedback='autonoma_errada') AS autonomas_corrigidas,
  COUNT(*) FILTER (WHERE c.analise_oc13_resultado->>'decisao'='sugerir_54_email') AS total_sugestoes,
  COUNT(*) FILTER (WHERE f.tipo_feedback IN ('sugestao_errada_explicita','sugestao_errada_implicita')) AS sugestoes_corrigidas,
  ROUND(100.0 * (1 - (COUNT(*) FILTER (WHERE f.id IS NOT NULL))::numeric
                       / NULLIF(COUNT(*) FILTER (WHERE c.analise_oc13_status='concluida'), 0)), 1)
    AS pct_acerto_ia
FROM public.cards c
LEFT JOIN public.agente_oc13_feedback f ON f.card_id = c.id
WHERE c.cod_ultima_ocorrencia = 13
  AND c.analise_oc13_status IS NOT NULL
  AND c.analise_oc13_atualizado_em IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2;

GRANT SELECT ON public.v_agente_oc13_metricas TO authenticated, service_role;

COMMENT ON VIEW public.v_agente_oc13_metricas IS
  'Métricas diárias de acerto do agente-oc13-autonomo, por operador. '
  'Alimenta indicador "🎯 Acerto Agente IA oc=13" na aba INDICADORES. Caio 2026-05-22.';
