-- ============================================================================
-- Cockpit v2 — RPCs de aprovação/rejeição usadas pela UI Lovable
-- Data: 2026-04-29
--
-- Hoje a UI faz INSERT card_event + UPDATE todo direto. Mas agora que temos
-- executor, o botão Aprovar precisa também ENFILEIRAR em pgmq.agent_executor.
--
-- pgmq não pode ser tocada por authenticated (RLS bloqueia). Solução: estes
-- RPCs SECURITY DEFINER fazem os 3 passos numa transação:
--   1. INSERT card_event (Aprovacao/RejeicaoOperador)
--   2. UPDATE todo (status + approved_by)
--   3. Enfileira em pgmq.agent_executor (apenas em aprovação)
--
-- Garantia atômica: se algo falha, transação reverte. Sem inconsistência.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.aprovar_e_executar(p_todo_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_todo record;
  v_card record;
  v_msg_id bigint;
BEGIN
  -- 1. Resolve operador autenticado
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores
  WHERE user_id = auth.uid()
  LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2. Pega o todo (precisa estar pendente)
  SELECT id, card_id, action_id, proposta_payload, status
  INTO v_todo
  FROM public.todos
  WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_todo.status <> 'pendente' THEN
    RAISE EXCEPTION 'Todo % já está em status=%, não pode aprovar de novo',
      p_todo_id, v_todo.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 3. Verifica permissão (operador dono OU gestor)
  SELECT id, assigned_operator_id, state, nf, ctrc
  INTO v_card
  FROM public.cards
  WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  IF v_operador_papel <> 'gestor' AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra aprovar todo do card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 4. INSERT card_event AprovacaoOperador
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id,
    'AprovacaoOperador',
    'operator',
    v_operador_id::text,
    jsonb_build_object(
      'todo_id', p_todo_id,
      'action_id', v_todo.action_id,
      'proposta_payload', v_todo.proposta_payload
    )
  );

  -- 5. UPDATE todo
  UPDATE public.todos
  SET status = 'aprovado',
      approved_by = v_operador_id,
      approved_at = now()
  WHERE id = p_todo_id;

  -- 6. Enfileira em agent_executor — executor consome
  v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
    'todo_id', p_todo_id,
    'card_id', v_todo.card_id,
    'action_id', v_todo.action_id,
    'proposta_payload', v_todo.proposta_payload,
    'aprovado_por', v_operador_id,
    'card_nf', v_card.nf,
    'card_ctrc', v_card.ctrc
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'todo_id', p_todo_id,
    'card_id', v_todo.card_id,
    'pgmq_msg_id', v_msg_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aprovar_e_executar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aprovar_e_executar(uuid) TO authenticated;

-- ============================================================================
-- rejeitar_acao(todo_id, motivo) — analog mas sem enqueue
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rejeitar_acao(
  p_todo_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_todo record;
  v_card_id uuid;
  v_card_assigned uuid;
BEGIN
  IF length(trim(coalesce(p_motivo, ''))) < 3 THEN
    RAISE EXCEPTION 'Motivo da rejeição obrigatório (mínimo 3 chars)';
  END IF;

  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado';
  END IF;

  SELECT id, card_id, action_id, status INTO v_todo
  FROM public.todos WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id;
  END IF;

  IF v_todo.status <> 'pendente' THEN
    RAISE EXCEPTION 'Todo % já em status=%', p_todo_id, v_todo.status;
  END IF;

  SELECT id, assigned_operator_id INTO v_card_id, v_card_assigned
  FROM public.cards WHERE id = v_todo.card_id;

  IF v_operador_papel <> 'gestor' AND v_card_assigned IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra rejeitar';
  END IF;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id,
    'RejeicaoOperador',
    'operator',
    v_operador_id::text,
    jsonb_build_object(
      'todo_id', p_todo_id,
      'action_id', v_todo.action_id,
      'motivo', p_motivo
    )
  );

  UPDATE public.todos
  SET status = 'rejeitado',
      approved_by = v_operador_id,
      approved_at = now(),
      rejection_reason = p_motivo
  WHERE id = p_todo_id;

  RETURN jsonb_build_object('ok', true, 'todo_id', p_todo_id);
END;
$$;

REVOKE ALL ON FUNCTION public.rejeitar_acao(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rejeitar_acao(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.aprovar_e_executar IS
  'Aprovação atômica de todo: grava event, atualiza status, enfileira no '
  'executor. Chamada pela UI Lovable no botão "Aprovar e executar". '
  'Substitui INSERT/UPDATE manual da UI.';
COMMENT ON FUNCTION public.rejeitar_acao IS
  'Rejeição com motivo obrigatório. Análoga a aprovar_e_executar mas sem enqueue.';
