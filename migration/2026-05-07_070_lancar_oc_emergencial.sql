-- ============================================================================
-- Cockpit v2 — RPC `lancar_oc_emergencial_acao_executada`
-- Data: 2026-05-07
--
-- Regra Caio 2026-05-07: card em state=ACAO_EXECUTADA está congelado (lock
-- bloqueia aprovação de propostas pré-criadas). Mas em casos excepcionais,
-- Larissa precisa lançar uma oc específica antes de Bastão confirmar a oc
-- anterior.
--
-- Esta RPC permite: Larissa abre o card em ACAO_EXECUTADA, clica "Lançar
-- outra oc", escolhe da lista de ocorrencias_dexpara ativas, opcionalmente
-- preenche texto_descricao (pra oc=41 etc), e dispara o lançamento.
--
-- Comportamento:
--  - Card permanece em ACAO_EXECUTADA com a NOVA oc + acao_executada_em=now()
--    (reset da janela). Aguarda Bastão confirmar a nova oc lançada.
--  - SEM email — emergência é só lançamento da oc no SSW.
--  - Card_event `AprovacaoEmergencialOperador` registra pra auditoria.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.lancar_oc_emergencial_acao_executada(
  p_card_id uuid,
  p_codigo_ssw int,
  p_texto_descricao text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_card record;
  v_oc record;
  v_chave_cte text;
  v_cnpj_remetente text;
  v_action_id uuid := gen_random_uuid();
  v_todo_id uuid := gen_random_uuid();
  v_proposta_payload jsonb;
  v_msg_id bigint;
  v_extras jsonb;
BEGIN
  -- 1. Auth
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2. Card check
  SELECT id, assigned_operator_id, state, nf, ctrc, sem_chave_cte, agent_state
  INTO v_card FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id;
  END IF;

  IF v_operador_papel <> 'gestor' AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra agir no card %', p_card_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_card.state <> 'ACAO_EXECUTADA' THEN
    RAISE EXCEPTION 'RPC emergencial só roda em cards em ACAO_EXECUTADA. Card % está em state=%', p_card_id, v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_card.sem_chave_cte = true THEN
    RAISE EXCEPTION 'Card NF % sem chave fiscal cadastrada — RPA OPC 455 ainda não importou.', v_card.nf
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 3. Validar oc — precisa estar em ocorrencias_dexpara.ativo=true
  SELECT codigo_ssw, codigo_api, descricao INTO v_oc
  FROM public.ocorrencias_dexpara
  WHERE codigo_ssw = p_codigo_ssw AND ativo = true;

  IF v_oc.codigo_ssw IS NULL THEN
    RAISE EXCEPTION 'Código SSW % não está na lista de ocorrências lançáveis (ocorrencias_dexpara ativo=true)', p_codigo_ssw
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 4. Extrai chave_cte + cnpj_remetente do agent_state
  v_chave_cte := v_card.agent_state->>'chave_cte';
  v_cnpj_remetente := COALESCE(
    v_card.agent_state->>'cnpj_remetente',
    v_card.agent_state->>'cnpj_pagador'
  );

  IF v_chave_cte IS NULL OR length(v_chave_cte) <> 44 THEN
    RAISE EXCEPTION 'Card NF % sem chave_cte válida no agent_state', v_card.nf
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 5. Monta extras: oc=41 (informação complementar) precisa de texto_descricao
  v_extras := '{}'::jsonb;
  IF p_texto_descricao IS NOT NULL AND length(trim(p_texto_descricao)) > 0 THEN
    v_extras := jsonb_build_object('texto_descricao', p_texto_descricao);
  END IF;

  -- 6. Monta proposta_payload (mesmo formato do flow normal)
  v_proposta_payload := jsonb_build_object(
    'tool', 'lancar_ocorrencia',
    'args', jsonb_build_object(
      'nf', v_card.nf,
      'codigo_ssw', p_codigo_ssw,
      'chave_cte', v_chave_cte,
      'cnpj_remetente', v_cnpj_remetente,
      'descricao', v_oc.descricao,
      'extras', v_extras
    ),
    'meta', jsonb_build_object(
      'modo', 'emergencial_acao_executada',
      'origem', 'lancar_oc_emergencial_acao_executada',
      'oc_anterior_card', v_card.agent_state->>'cod_ultima_ocorrencia'
    ),
    'rationale', 'Caio 2026-05-07: lançamento emergencial em card ACAO_EXECUTADA — Larissa escolheu oc=' || p_codigo_ssw::text || ' fora das propostas pré-criadas.'
  );

  -- 7. Cria todo + action_id já aprovado
  INSERT INTO public.todos (
    id, card_id, action_id, descricao, proposta_payload,
    status, approved_by, approved_at
  ) VALUES (
    v_todo_id, p_card_id, v_action_id,
    'Lançamento emergencial oc=' || p_codigo_ssw || ' (' || v_oc.descricao || ')',
    v_proposta_payload,
    'aprovado', v_operador_id, now()
  );

  -- 8. Audit event
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'AprovacaoEmergencialOperador', 'operator', v_operador_id::text,
    jsonb_build_object(
      'todo_id', v_todo_id,
      'action_id', v_action_id,
      'codigo_ssw', p_codigo_ssw,
      'descricao_oc', v_oc.descricao,
      'texto_descricao', p_texto_descricao,
      'proposta_payload', v_proposta_payload,
      'observacao', 'Lançamento emergencial em card ACAO_EXECUTADA — bypassa lock pra Larissa lançar oc fora das propostas pré-criadas.'
    )
  );

  -- 9. Enfileira no executor
  v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
    'todo_id', v_todo_id,
    'card_id', p_card_id,
    'action_id', v_action_id,
    'proposta_payload', v_proposta_payload,
    'aprovado_por', v_operador_id,
    'card_nf', v_card.nf,
    'card_ctrc', v_card.ctrc
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'todo_id', v_todo_id,
    'action_id', v_action_id,
    'card_id', p_card_id,
    'codigo_ssw', p_codigo_ssw,
    'descricao_oc', v_oc.descricao,
    'pgmq_msg_id', v_msg_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lancar_oc_emergencial_acao_executada(uuid, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lancar_oc_emergencial_acao_executada(uuid, int, text) TO authenticated;

COMMENT ON FUNCTION public.lancar_oc_emergencial_acao_executada(uuid, int, text) IS
  'Caio 2026-05-07: lança oc emergencial em card ACAO_EXECUTADA (bypassa lock). '
  'Larissa escolhe da lista de ocorrencias_dexpara ativas. Sem email — só '
  'lançamento. Após sucesso, executor reseta acao_executada_em=now() e card '
  'aguarda Bastão confirmar a nova oc.';
