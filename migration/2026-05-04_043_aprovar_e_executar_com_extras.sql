-- ============================================================================
-- Cockpit v2 — aprovar_e_executar aceita extras (info preenchida pela operadora)
-- Data: 2026-05-04
--
-- Caso de uso: oc=44 (retorno de carga). Antes de aprovar, Larissa precisa
-- preencher: quantidade_volumes, motivo, filial. Esses valores vão pra
-- descrição da oc no SSW + ficam registrados no card_event pra histórico.
--
-- Implementação: novo parâmetro `p_extras jsonb` (opcional). Se preenchido,
-- merge no proposta_payload.args.extras antes de enfileirar no executor.
-- Executor concatena os valores na descrição final que vai pro SSW.
--
-- Mantém retrocompatibilidade: chamadas sem p_extras (oc=21, 54, 56, etc)
-- continuam funcionando exatamente como antes.
--
-- Idempotência: drop da assinatura antiga, recria com novo parâmetro.
-- ============================================================================

DROP FUNCTION IF EXISTS public.aprovar_e_executar(uuid);

CREATE OR REPLACE FUNCTION public.aprovar_e_executar(
  p_todo_id uuid,
  p_extras jsonb DEFAULT NULL
)
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
  v_outros_cancelados int;
  v_proposta_payload jsonb;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, card_id, action_id, proposta_payload, status
  INTO v_todo FROM public.todos WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_todo.status <> 'pendente' THEN
    RAISE EXCEPTION 'Todo % já em status=%', p_todo_id, v_todo.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, assigned_operator_id, state, nf, ctrc INTO v_card
  FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  IF v_operador_papel <> 'gestor' AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra aprovar todo do card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Merge extras no proposta_payload.args (se fornecido). Mantém todo o
  -- payload original e adiciona/sobrescreve só o args.extras.
  v_proposta_payload := v_todo.proposta_payload;
  IF p_extras IS NOT NULL AND jsonb_typeof(p_extras) = 'object' THEN
    v_proposta_payload := jsonb_set(
      v_proposta_payload,
      '{args,extras}',
      p_extras,
      true
    );
  END IF;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id, 'AprovacaoOperador', 'operator', v_operador_id::text,
    jsonb_build_object(
      'todo_id', p_todo_id,
      'action_id', v_todo.action_id,
      'proposta_payload', v_proposta_payload,
      'extras', p_extras
    )
  );

  UPDATE public.todos
  SET status = 'aprovado',
      approved_by = v_operador_id,
      approved_at = now(),
      proposta_payload = v_proposta_payload
  WHERE id = p_todo_id;

  WITH outros_canc AS (
    UPDATE public.todos
    SET status = 'cancelado',
        rejection_reason = 'Auto-cancelado: outra opção foi aprovada no mesmo card'
    WHERE card_id = v_todo.card_id
      AND id <> p_todo_id
      AND status = 'pendente'
    RETURNING id
  )
  SELECT count(*) INTO v_outros_cancelados FROM outros_canc;

  IF v_outros_cancelados > 0 THEN
    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (
      v_todo.card_id, 'TodosConcorrentesCancelados', 'system', 'aprovar_e_executar',
      jsonb_build_object(
        'aprovado', p_todo_id,
        'cancelados', v_outros_cancelados,
        'motivo', 'Operadora escolheu uma das opções; demais ficaram obsoletas'
      )
    );
  END IF;

  -- Aprovação destrava lock + limpa aviso de alteração de oc + state EXECUTANDO_ACAO
  UPDATE public.cards
  SET aprovacao_modo = 'humana',
      lock_aguardando_validacao = false,
      aviso_alteracao_oc = NULL,
      state = 'EXECUTANDO_ACAO'
  WHERE id = v_todo.card_id;

  v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
    'todo_id', p_todo_id, 'card_id', v_todo.card_id,
    'action_id', v_todo.action_id, 'proposta_payload', v_proposta_payload,
    'aprovado_por', v_operador_id, 'card_nf', v_card.nf, 'card_ctrc', v_card.ctrc
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'todo_id', p_todo_id,
    'card_id', v_todo.card_id,
    'pgmq_msg_id', v_msg_id,
    'outros_cancelados', v_outros_cancelados,
    'extras_aplicados', p_extras IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aprovar_e_executar(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aprovar_e_executar(uuid, jsonb) TO authenticated;
