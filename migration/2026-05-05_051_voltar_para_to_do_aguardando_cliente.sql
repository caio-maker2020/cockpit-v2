-- ============================================================================
-- Cockpit v2 — voltar_para_to_do agora trata cards em AGUARDANDO_CLIENTE
-- Data: 2026-05-05
--
-- Pedido por Caio: cards em AGUARDANDO_CLIENTE (com oc=54) precisam ter botão
-- "Voltar pra To-Do" também. Diferente do uso original (AGUARDANDO_VALIDACAO_HUMANA
-- com oc qualquer), aqui o comportamento é:
--   - Força state=AGUARDANDO_AGENTE (PARA FAZER)
--   - Cancela TODAS as 5 propostas pendentes [21, 33, 44, 55, 56]
--   - Larissa vai cuidar do card manualmente depois (ou sync recria propostas)
--
-- Pra outros states (AGUARDANDO_VALIDACAO_HUMANA), comportamento original:
-- recalcula state via state_pelo_bastao + mantém todos pendentes (Larissa
-- pode aprovar depois).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.voltar_para_to_do(
  p_todo_id uuid,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_todo record;
  v_card record;
  v_new_state text;
  v_state_anterior text;
  v_todos_cancelados int := 0;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, card_id, action_id, status INTO v_todo
  FROM public.todos WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_todo.status <> 'pendente' THEN
    RAISE EXCEPTION 'Todo % já em status=% (só funciona quando pendente)',
      p_todo_id, v_todo.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, assigned_operator_id, cod_ultima_ocorrencia, agent_state, state
  INTO v_card FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  IF v_operador_papel <> 'gestor'
     AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra voltar todo do card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_state_anterior := v_card.state;

  -- Branch novo: cards em AGUARDANDO_CLIENTE → força AGUARDANDO_AGENTE +
  -- cancela TODAS propostas pendentes (decisão Caio 2026-05-05).
  IF v_card.state = 'AGUARDANDO_CLIENTE' THEN
    WITH canc AS (
      UPDATE public.todos
      SET status = 'cancelado',
          rejection_reason = 'voltar_para_to_do em AGUARDANDO_CLIENTE — operadora pediu'
      WHERE card_id = v_card.id AND status = 'pendente'
      RETURNING 1
    )
    SELECT count(*) INTO v_todos_cancelados FROM canc;

    v_new_state := 'AGUARDANDO_AGENTE';
  ELSE
    -- Branch original: AGUARDANDO_VALIDACAO_HUMANA etc.
    -- Recalcula state via dicionário; mantém todos pendentes (Larissa pode aprovar depois).
    v_new_state := public.state_pelo_bastao(
      v_card.cod_ultima_ocorrencia,
      v_card.agent_state->>'responsavel_atual'
    );
    IF v_new_state IS NULL THEN
      v_new_state := 'AGUARDANDO_AGENTE';
    END IF;
  END IF;

  UPDATE public.cards
  SET state = v_new_state,
      lock_aguardando_validacao = false
  WHERE id = v_card.id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_card.id,
    'TodoVoltadoParaToDo',
    'operator',
    v_operador_id::text,
    jsonb_build_object(
      'todo_id', p_todo_id,
      'action_id', v_todo.action_id,
      'motivo', coalesce(p_motivo, '(sem motivo informado)'),
      'state_anterior', v_state_anterior,
      'state_novo', v_new_state,
      'todos_cancelados', v_todos_cancelados
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'todo_id', p_todo_id,
    'card_id', v_card.id,
    'new_state', v_new_state,
    'todos_cancelados', v_todos_cancelados
  );
END;
$$;

REVOKE ALL ON FUNCTION public.voltar_para_to_do(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.voltar_para_to_do(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.voltar_para_to_do(uuid, text) IS
  'Voltar card pra to-do. Em AGUARDANDO_CLIENTE: força AGUARDANDO_AGENTE + cancela todas propostas. '
  'Em outros states: recalcula via state_pelo_bastao, mantém propostas pendentes.';
