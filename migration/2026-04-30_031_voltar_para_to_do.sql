-- ============================================================================
-- Cockpit v2 — RPC voltar_para_to_do (destrava lock, mantém todo pendente)
-- Data: 2026-04-30
--
-- Pedido por Caio em 2026-04-30: quando card está em AGUARDANDO_VALIDACAO_HUMANA
-- com auto-proposta (ex: oc=20 → propor 55), Larissa precisa de uma terceira
-- opção além de "Aprovar" e "Rejeitar": "Voltar para o To-Do" — destrava
-- o lock + manda card pra AGUARDANDO_AGENTE (PARA FAZER), mas mantém o todo
-- pendente pra que ela aprove depois quando estiver pronta.
--
-- Diferença de "Rejeitar": rejeitar marca todo='rejeitado' (não volta mais);
-- voltar_para_to_do mantém status='pendente'.
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

  SELECT id, assigned_operator_id, cod_ultima_ocorrencia, agent_state
  INTO v_card FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  IF v_operador_papel <> 'gestor'
     AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra voltar todo do card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Recalcula state usando a mesma regra dinâmica do sync-bastao
  v_new_state := public.state_pelo_bastao(
    v_card.cod_ultima_ocorrencia,
    v_card.agent_state->>'responsavel_atual'
  );

  -- Se a regra apontar pra TRANSFERIDO/AGUARDANDO_CLIENTE, respeita.
  -- Senão volta pra AGUARDANDO_AGENTE (PARA FAZER) — caso típico do oc=20.
  IF v_new_state IS NULL THEN
    v_new_state := 'AGUARDANDO_AGENTE';
  END IF;

  -- Destrava lock + muda state. Todo continua pendente — Larissa pode
  -- aprovar depois acessando a aba AGUARDANDO VALIDAÇÃO HUMANA.
  -- (Se ela quiser, no futuro adiciono botão direto da aba PARA FAZER.)
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
      'state_anterior', 'AGUARDANDO_VALIDACAO_HUMANA',
      'state_novo', v_new_state,
      'todo_status', 'pendente — disponível pra aprovação posterior'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'todo_id', p_todo_id,
    'card_id', v_card.id,
    'new_state', v_new_state,
    'todo_status', 'pendente'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.voltar_para_to_do(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.voltar_para_to_do(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.voltar_para_to_do(uuid, text) IS
  'Terceira opção do operador além de aprovar/rejeitar: destrava o lock '
  'do card + manda pra estado coerente com a oc atual (geralmente '
  'AGUARDANDO_AGENTE), mantendo todo pendente. Útil quando operador '
  'quer pensar/tratar mais antes de aprovar a auto-proposta.';
