-- ============================================================================
-- Cockpit v2 — cards.aprovacao_modo (humana / autonoma / NULL)
-- Data: 2026-04-29
--
-- Nasceu pro Kanban do Lovable separar visualmente:
--   "AÇÃO EXECUTADA" → cards aprovados por operador humano
--   "AÇÃO AUTÔNOMA"  → cards aprovados pelo sistema (regra auto-aprovação)
--
-- Sem essa coluna, a UI precisaria join em todos.auto_approval_rule ou em
-- card_events — caro pra Kanban que recarrega frequente.
--
-- Modelo:
--   - NULL  → ainda não houve aprovação (card está em pré-aprovação)
--   - humana   → operador clicou Aprovar via aprovar_e_executar
--   - autonoma → vinculador auto-aprovou via auto_aprovar_e_executar
--
-- As 2 RPCs são atualizadas pra popular essa coluna.
-- ============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS aprovacao_modo text
    CHECK (aprovacao_modo IS NULL OR aprovacao_modo IN ('humana', 'autonoma'));

CREATE INDEX IF NOT EXISTS idx_cards_aprovacao_modo
  ON public.cards(aprovacao_modo)
  WHERE aprovacao_modo IS NOT NULL;

COMMENT ON COLUMN public.cards.aprovacao_modo IS
  'Como a ação proposta pelo agente foi aprovada: humana (operador clicou) | '
  'autonoma (regra auto-aprovação no vinculador). NULL = ainda não aprovado. '
  'Usado pela UI pra separar Kanban "Ação Executada" vs "Ação Autônoma".';

-- ============================================================================
-- aprovar_e_executar — agora seta aprovacao_modo='humana' no card
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
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, card_id, action_id, proposta_payload, status
  INTO v_todo
  FROM public.todos WHERE id = p_todo_id;

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

  UPDATE public.todos
  SET status = 'aprovado',
      approved_by = v_operador_id,
      approved_at = now()
  WHERE id = p_todo_id;

  -- Marca o card como aprovado por humano (Kanban filtra por isso)
  UPDATE public.cards
  SET aprovacao_modo = 'humana'
  WHERE id = v_todo.card_id;

  v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
    'todo_id', p_todo_id,
    'card_id', v_todo.card_id,
    'action_id', v_todo.action_id,
    'proposta_payload', v_todo.proposta_payload,
    'aprovado_por', v_operador_id,
    'card_nf', v_card.nf,
    'card_ctrc', v_card.ctrc
  ));

  RETURN jsonb_build_object('ok', true, 'todo_id', p_todo_id, 'card_id', v_todo.card_id, 'pgmq_msg_id', v_msg_id);
END;
$$;

REVOKE ALL ON FUNCTION public.aprovar_e_executar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aprovar_e_executar(uuid) TO authenticated;

-- ============================================================================
-- auto_aprovar_e_executar — seta aprovacao_modo='autonoma'
-- ============================================================================
CREATE OR REPLACE FUNCTION public.auto_aprovar_e_executar(
  p_todo_id uuid,
  p_regra text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_todo record;
  v_card record;
  v_msg_id bigint;
BEGIN
  IF p_regra IS NULL OR length(trim(p_regra)) = 0 THEN
    RAISE EXCEPTION 'Regra de auto-aprovação obrigatória';
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

  SELECT id, nf, ctrc INTO v_card FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id, 'AutoAprovacaoPermitida', 'system', 'vinculador',
    jsonb_build_object(
      'todo_id', p_todo_id,
      'action_id', v_todo.action_id,
      'regra', p_regra,
      'proposta_payload', v_todo.proposta_payload
    )
  );

  UPDATE public.todos
  SET status = 'aprovado', approved_by = NULL, approved_at = now(),
      auto_approval_rule = p_regra
  WHERE id = p_todo_id;

  -- Marca o card como aprovado pelo sistema (Kanban filtra por isso)
  UPDATE public.cards
  SET aprovacao_modo = 'autonoma'
  WHERE id = v_todo.card_id;

  v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
    'todo_id', p_todo_id, 'card_id', v_todo.card_id, 'action_id', v_todo.action_id,
    'proposta_payload', v_todo.proposta_payload,
    'aprovado_por', NULL, 'auto_approval_rule', p_regra,
    'card_nf', v_card.nf, 'card_ctrc', v_card.ctrc
  ));

  RETURN jsonb_build_object('ok', true, 'todo_id', p_todo_id, 'card_id', v_todo.card_id,
                            'regra', p_regra, 'pgmq_msg_id', v_msg_id);
END;
$$;

REVOKE ALL ON FUNCTION public.auto_aprovar_e_executar(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_aprovar_e_executar(uuid, text) TO service_role;

-- ============================================================================
-- BACKFILL: cards já existentes — popula aprovacao_modo a partir de card_events
-- Cards que receberam AprovacaoOperador → humana
-- Cards que receberam AutoAprovacaoPermitida → autonoma
-- ============================================================================
UPDATE public.cards c SET aprovacao_modo = 'autonoma'
WHERE aprovacao_modo IS NULL
  AND EXISTS (
    SELECT 1 FROM public.card_events e
    WHERE e.card_id = c.id AND e.event_type = 'AutoAprovacaoPermitida'
  );

UPDATE public.cards c SET aprovacao_modo = 'humana'
WHERE aprovacao_modo IS NULL
  AND EXISTS (
    SELECT 1 FROM public.card_events e
    WHERE e.card_id = c.id AND e.event_type = 'AprovacaoOperador'
  );
