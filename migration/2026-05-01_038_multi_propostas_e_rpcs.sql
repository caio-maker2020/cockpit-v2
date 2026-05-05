-- ============================================================================
-- Cockpit v2 — Múltiplas propostas por card + RPCs ajustadas
-- Data: 2026-05-01
--
-- Mudanças:
-- 1. aprovar_e_executar: ao aprovar 1 todo, cancela os outros pendentes do
--    mesmo card (evita executar 2 ações concorrentes).
-- 2. voltar_para_to_do: cancela TODOS os todos pendentes do card (não só o
--    passado por parâmetro). Senão proposta concorrente fica pendurada.
-- 3. marcar_retorno_inconclusivo: cancela TODOS os todos pendentes do card.
-- 4. Stub do template RECUSA_TOTAL pra regra oc=10 (Larissa preenche depois).
--
-- Não mexe em rejeitar_acao porque o botão Rejeitar vai sumir da plataforma.
-- A função fica no banco mas frontend não chama mais.
-- ============================================================================

-- =============================================================================
-- 1. aprovar_e_executar — cancela outros todos pendentes do card
-- =============================================================================
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
  v_outros_cancelados int;
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

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id, 'AprovacaoOperador', 'operator', v_operador_id::text,
    jsonb_build_object(
      'todo_id', p_todo_id, 'action_id', v_todo.action_id,
      'proposta_payload', v_todo.proposta_payload
    )
  );

  UPDATE public.todos
  SET status = 'aprovado', approved_by = v_operador_id, approved_at = now()
  WHERE id = p_todo_id;

  -- Cancela OUTROS todos pendentes do mesmo card. Quando uma das opções é
  -- escolhida (ex: lançar 21 num card oc=54 que tinha [21, 55]), as outras
  -- ficam obsoletas — operadora decidiu o caminho.
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

  -- Aprovação destrava lock + marca aprovação humana + state passa pra
  -- EXECUTANDO_ACAO. Próximo sync-bastao acompanha (Pass C).
  UPDATE public.cards
  SET aprovacao_modo = 'humana',
      lock_aguardando_validacao = false,
      state = 'EXECUTANDO_ACAO'
  WHERE id = v_todo.card_id;

  v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
    'todo_id', p_todo_id, 'card_id', v_todo.card_id,
    'action_id', v_todo.action_id, 'proposta_payload', v_todo.proposta_payload,
    'aprovado_por', v_operador_id, 'card_nf', v_card.nf, 'card_ctrc', v_card.ctrc
  ));

  RETURN jsonb_build_object(
    'ok', true, 'todo_id', p_todo_id,
    'card_id', v_todo.card_id, 'pgmq_msg_id', v_msg_id,
    'outros_cancelados', v_outros_cancelados
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aprovar_e_executar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aprovar_e_executar(uuid) TO authenticated;

-- =============================================================================
-- 2. voltar_para_to_do — cancela TODOS os todos pendentes do card
-- =============================================================================
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
  v_outros_cancelados int;
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

  -- Em vez de exigir todo='pendente', aceita qualquer todo do card. A função
  -- agora cancela TODOS os pendentes do card de uma vez (semântica "voltar
  -- pro to-do" é sobre o CARD, não sobre 1 todo específico).

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

  v_new_state := public.state_pelo_bastao(
    v_card.cod_ultima_ocorrencia,
    v_card.agent_state->>'responsavel_atual'
  );

  IF v_new_state IS NULL THEN
    v_new_state := 'AGUARDANDO_AGENTE';
  END IF;

  -- Cancela TODOS os todos pendentes do card (não só p_todo_id).
  -- Conceitualmente "voltar pro to-do" = limpar todas as propostas e
  -- deixar operadora tocar manual.
  WITH todos_canc AS (
    UPDATE public.todos
    SET status = 'cancelado',
        rejection_reason = coalesce(p_motivo, 'voltar_para_to_do')
    WHERE card_id = v_todo.card_id AND status = 'pendente'
    RETURNING id
  )
  SELECT count(*) INTO v_outros_cancelados FROM todos_canc;

  -- Destrava lock + muda state pro coerente com a oc atual.
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
      'todo_id_origem', p_todo_id,
      'motivo', coalesce(p_motivo, '(sem motivo)'),
      'state_novo', v_new_state,
      'todos_cancelados', v_outros_cancelados
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', v_card.id,
    'new_state', v_new_state,
    'todos_cancelados', v_outros_cancelados
  );
END;
$$;

REVOKE ALL ON FUNCTION public.voltar_para_to_do(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.voltar_para_to_do(uuid, text) TO authenticated;

-- =============================================================================
-- 3. marcar_retorno_inconclusivo — cancela TODOS os todos pendentes do card
-- =============================================================================
CREATE OR REPLACE FUNCTION public.marcar_retorno_inconclusivo(
  p_card_id uuid,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_card record;
  v_acoes_canc int;
  v_todos_canc int;
  v_nova_acao bigint;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, assigned_operator_id, state, lock_aguardando_validacao
  INTO v_card FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor'
     AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Aceita tanto AGUARDANDO_AGENTE quanto AGUARDANDO_VALIDACAO_HUMANA
  -- (caso venha do flow de cliente respondeu → validação humana com lock)
  IF v_card.state NOT IN ('AGUARDANDO_AGENTE', 'AGUARDANDO_VALIDACAO_HUMANA') THEN
    RAISE EXCEPTION 'Só funciona em AGUARDANDO_AGENTE ou AGUARDANDO_VALIDACAO_HUMANA (atual: %)', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 1. Cancela ações agendadas (relógio antigo)
  WITH canc AS (
    UPDATE public.acoes_agendadas
    SET status = 'cancelado',
        cancelado_motivo = 'retorno marcado como inconclusivo'
    WHERE card_id = p_card_id AND status = 'pendente'
    RETURNING 1
  )
  SELECT count(*) INTO v_acoes_canc FROM canc;

  -- 2. Cancela TODOS os todos pendentes do card (limpa propostas obsoletas)
  WITH todos_canc AS (
    UPDATE public.todos
    SET status = 'cancelado',
        rejection_reason = 'retorno inconclusivo — operadora reiniciou ciclo'
    WHERE card_id = p_card_id AND status = 'pendente'
    RETURNING 1
  )
  SELECT count(*) INTO v_todos_canc FROM todos_canc;

  -- 3. Move card pra AGUARDANDO_CLIENTE + destrava lock
  UPDATE public.cards
  SET state = 'AGUARDANDO_CLIENTE',
      lock_aguardando_validacao = false
  WHERE id = p_card_id;

  -- 4. Agenda nova cobrança em D+4
  INSERT INTO public.acoes_agendadas (card_id, tipo, executar_em, payload)
  VALUES (
    p_card_id,
    'cobranca_email',
    now() + interval '4 days',
    jsonb_build_object(
      'template_id', 'COBRANCA_LEMBRETE',
      'dias_aguardar', 4,
      'agendado_em', now(),
      'origem', 'retorno_inconclusivo'
    )
  )
  RETURNING id INTO v_nova_acao;

  -- 5. Audit
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id,
    'RetornoMarcadoComoInconclusivo',
    'operator',
    v_operador_id::text,
    jsonb_build_object(
      'motivo', coalesce(p_motivo, '(sem motivo)'),
      'acoes_canceladas', v_acoes_canc,
      'todos_cancelados', v_todos_canc,
      'nova_acao_agendada_id', v_nova_acao,
      'reagendado_para', now() + interval '4 days',
      'state_anterior', v_card.state,
      'state_novo', 'AGUARDANDO_CLIENTE'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', p_card_id,
    'acoes_canceladas', v_acoes_canc,
    'todos_cancelados', v_todos_canc,
    'nova_cobranca_em', now() + interval '4 days'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.marcar_retorno_inconclusivo(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_retorno_inconclusivo(uuid, text) TO authenticated;

-- =============================================================================
-- 4. Template stub RECUSA_TOTAL (oc=10) — Larissa preenche depois
-- =============================================================================
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'RECUSA_TOTAL',
  'Recusa total da entrega — solicitar tratativa',
  'Quando cliente recusou totalmente a entrega no destino. Precisa decidir entre devolução / endereço novo / contestação.',
  '[Sal Express] NF {nf} — recusa total da entrega',
  E'Olá {primeiro_nome},\n\n' ||
  E'A entrega da NF {nf} foi recusada totalmente no destino.\n\n' ||
  E'Como prefere prosseguir?\n' ||
  E'1) Confirmar devolução total\n' ||
  E'2) Solicitar nova tentativa de entrega em outro endereço\n' ||
  E'3) Contestar a recusa\n\n' ||
  E'Aguardo retorno.\n\n' ||
  E'{operadora_nome}\nSal Express — Relacionamento',
  ARRAY['primeiro_nome', 'nf', 'operadora_nome'],
  false  -- inativo até Larissa preencher texto final
)
ON CONFLICT (id) DO NOTHING;
