-- ============================================================================
-- Cockpit v2 — agente_ocs_padrao_feedback: novo tipo_feedback
-- 'caso_nao_reconhecido' + RPC registrar_feedback_oc49_caso_desconhecido.
-- Data: 2026-05-29
-- skill: supabase-postgres-best-practices
--
-- Usado pelo catch-all do agente em oc=49: quando nenhum dos 3 casos
-- conhecidos (extravio / cobrança retorno / devolução pós-56) bate, banner
-- mostra textarea pro operador descrever o caso real. Submit chama esta RPC.
-- Caio lê periodicamente:
--   SELECT motivo_correcao, COUNT(*) FROM public.agente_ocs_padrao_feedback
--   WHERE tipo_feedback='caso_nao_reconhecido' GROUP BY motivo_correcao
--   ORDER BY count DESC;
-- pra identificar padrões reais e expandir o agente.
--
-- skill checklist:
--   - DROP + ADD CONSTRAINT (Postgres não aceita IF NOT EXISTS em CHECK nominado) ✓
--   - RPC SECURITY DEFINER + SET search_path = public ✓
--   - auth.uid() obrigatório (operador autenticado registra) ✓
--   - Mínimo 10 chars no motivo (evita feedback vazio) ✓
--   - GRANT EXECUTE pra authenticated ✓
-- ============================================================================

ALTER TABLE public.agente_ocs_padrao_feedback
  DROP CONSTRAINT IF EXISTS agente_ocs_padrao_feedback_tipo_feedback_check;

ALTER TABLE public.agente_ocs_padrao_feedback
  ADD CONSTRAINT agente_ocs_padrao_feedback_tipo_feedback_check
  CHECK (tipo_feedback IN (
    'sugestao_errada_explicita',
    'sugestao_errada_implicita',
    'sugestao_certa_explicita',
    'sugestao_certa_implicita',
    'caso_nao_reconhecido'
  ));

CREATE OR REPLACE FUNCTION public.registrar_feedback_oc49_caso_desconhecido(
  p_card_id uuid,
  p_explicacao text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_user_nome text;
  v_codigo_oc int;
  v_decisao_ia jsonb;
  v_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth.uid() vazio — operador precisa estar autenticado';
  END IF;
  IF p_card_id IS NULL THEN
    RAISE EXCEPTION 'p_card_id é obrigatório';
  END IF;
  IF p_explicacao IS NULL OR length(btrim(p_explicacao)) < 10 THEN
    RAISE EXCEPTION 'p_explicacao precisa ter pelo menos 10 caracteres';
  END IF;

  -- Snapshot da decisão IA atual + oc do card (pra contexto)
  SELECT cod_ultima_ocorrencia, analise_padrao_resultado
    INTO v_codigo_oc, v_decisao_ia
  FROM public.cards
  WHERE id = p_card_id;

  -- Nome do operador (informacional)
  SELECT nome INTO v_user_nome FROM public.operadores WHERE id = v_user_id;

  INSERT INTO public.agente_ocs_padrao_feedback (
    card_id, codigo_oc_card, tipo_feedback,
    decisao_ia, decisao_correta_codigo_ssw, motivo_correcao,
    corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id,
    v_codigo_oc,
    'caso_nao_reconhecido',
    COALESCE(v_decisao_ia, '{}'::jsonb),
    NULL,  -- desconhecido por definição
    btrim(p_explicacao),
    v_user_id,
    v_user_nome
  )
  RETURNING id INTO v_id;

  -- Audit no card_events (mantém histórico mesmo se row deletada futuramente)
  INSERT INTO public.card_events (
    card_id, event_type, actor_type, actor_id, payload
  ) VALUES (
    p_card_id,
    'FeedbackAgenteOc49CasoDesconhecido',
    'operator',
    v_user_id::text,
    jsonb_build_object(
      'feedback_id', v_id,
      'explicacao', btrim(p_explicacao),
      'codigo_oc_card', v_codigo_oc
    )
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_feedback_oc49_caso_desconhecido(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.registrar_feedback_oc49_caso_desconhecido(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.registrar_feedback_oc49_caso_desconhecido(uuid, text) IS
  'Caio 2026-05-29: catch-all do agente oc=49. Operador descreve qual caso real veio '
  '(além dos 3 conhecidos: extravio / cobrança retorno / devolução pós-56) pra '
  'Caio analisar padrões e expandir o agente. Registra em agente_ocs_padrao_feedback '
  'com tipo_feedback=caso_nao_reconhecido + card_events FeedbackAgenteOc49CasoDesconhecido.';
