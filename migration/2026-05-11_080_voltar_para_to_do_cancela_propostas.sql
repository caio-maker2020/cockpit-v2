-- ============================================================================
-- Cockpit v2 — voltar_para_to_do agora cancela propostas em QUALQUER state
-- Data: 2026-05-11
--
-- Bug raiz NF 64409 / 422589 (Caio 2026-05-11):
-- Larissa movia card de AGUARDANDO_VALIDACAO_HUMANA → AGUARDANDO_AGENTE
-- ("voltar pra TO-DO") esperando a oc atualizar e o card sair da plataforma.
-- Mas o sync seguinte (proporAutoAcaoSeAplicavel) detectava
-- "AGUARDANDO_AGENTE + propostas ativas pré-existentes" e forçava o card
-- de volta pra AGUARDANDO_VALIDACAO_HUMANA + lock=true via
-- `LockAjustadoPropostasExistentes`. Loop até a oc mudar.
--
-- Causa: branch "ELSE" de voltar_para_to_do v1 mantinha propostas pendentes
-- (so cancelava em AGUARDANDO_CLIENTE). Como REGRAS_AUTO_ACAO de oc=20 só
-- tem 1 proposta (lançar 55), e essa proposta já existia, o sync sempre
-- detectava "propostas ativas" e re-lockava.
--
-- Fix Caio 2026-05-11: cancela TODAS as propostas pendentes ao voltar pra
-- TO-DO, independente do state anterior. Sync recria propostas naturalmente
-- na próxima oc mudar (REGRAS_AUTO_ACAO[nova_oc]).
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

  -- Caio 2026-05-11: SEMPRE cancela todas as propostas pendentes (não só
  -- em AGUARDANDO_CLIENTE como antes). Evita loop com LockAjustadoPropostasExistentes
  -- do proporAutoAcaoSeAplicavel. Sync recria propostas quando a oc mudar.
  WITH canc AS (
    UPDATE public.todos
    SET status = 'cancelado',
        rejection_reason = COALESCE(
          'voltar_para_to_do em ' || v_state_anterior || ' — operadora pediu (' || COALESCE(p_motivo, 'sem motivo') || ')',
          'voltar_para_to_do — operadora pediu'
        )
    WHERE card_id = v_card.id AND status = 'pendente'
    RETURNING 1
  )
  SELECT count(*) INTO v_todos_cancelados FROM canc;

  -- State pós-volta:
  --   - AGUARDANDO_CLIENTE → AGUARDANDO_AGENTE (preserva regra Caio 2026-05-05)
  --   - Outros → recalcula via state_pelo_bastao (oc atual + responsavel_atual)
  IF v_card.state = 'AGUARDANDO_CLIENTE' THEN
    v_new_state := 'AGUARDANDO_AGENTE';
  ELSE
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
      'todos_cancelados', v_todos_cancelados,
      'observacao', 'v2 2026-05-11: cancela todas propostas pendentes em qualquer state pra evitar loop com LockAjustadoPropostasExistentes.'
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

COMMENT ON FUNCTION public.voltar_para_to_do(uuid, text) IS
  'Caio 2026-05-11 v2: voltar card pra to-do. SEMPRE cancela todas propostas '
  'pendentes (não só em AGUARDANDO_CLIENTE). Evita loop com '
  'LockAjustadoPropostasExistentes do sync. Sync recria propostas quando '
  'a oc mudar (REGRAS_AUTO_ACAO[nova_oc]).';
