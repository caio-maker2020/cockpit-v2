-- ============================================================================
-- Cockpit v2 — aprovar_e_executar v4: preserva cliente_respondeu_em e
-- ia_sugestao_oc_resposta até o executor confirmar sucesso (ACAO_EXECUTADA).
-- Data: 2026-05-11
--
-- Bug raiz NF 351849 (Caio 2026-05-11):
-- 1. Larissa aprovou oc=21 sugerida pela IA → aprovar_e_executar limpou
--    cliente_respondeu_em + ia_sugestao_oc_resposta (regra antiga da mig 062).
-- 2. Executor → SSW retornou 400 "DOCUMENTO BAIXADO OU ENTREGUE" (chave_cte
--    do CT-e de reentrega — bug paralelo corrigido em mig 082).
-- 3. reverter_acao_falhou (mig 049) ressuscitou 15 todos + state=AVH + lock=true,
--    MAS não restaurou cliente_respondeu_em / ia_sugestao_oc_resposta (já tinham
--    sido perdidos pela aprovação).
-- 4. Pass A do sync-bastao rodou → bastao.oc=54 → exceção
--    `existing.state === 'AGUARDANDO_VALIDACAO_HUMANA' && clienteJaRespondeu`
--    FALHOU (clienteJaRespondeu agora era false) → forçou AGUARDANDO_CLIENTE.
-- 5. Card sumiu da aba CLIENTE RESPONDEU sem ter sido resolvido.
--
-- Fix raiz: aprovar_e_executar NÃO limpa esses 2 campos. A limpeza correta
-- acontece no executor quando seta state=ACAO_EXECUTADA (sucesso confirmado
-- SSW) — já implementado em executor/index.ts linhas 792-793.
--
-- Em caso de falha (executor → reverter_acao_falhou), os campos sobrevivem
-- → Pass A respeita a exceção → card volta naturalmente pra aba CLIENTE
-- RESPONDEU com sugestão IA preservada → Larissa pode tentar outra opção.
--
-- Side effect positivo: cron-ia-resposta-pendentes (mig 081) também respeita
-- — só preenche ia_sugestao_oc_resposta se está null E cliente_respondeu_em
-- não. Como ambos seguem preenchidos, cron não retenta IA inútilmente.
-- ============================================================================

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
  v_tool text;
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

  SELECT id, assigned_operator_id, state, nf, ctrc, sem_chave_cte INTO v_card
  FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  IF v_operador_papel <> 'gestor' AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra aprovar todo do card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_tool := v_todo.proposta_payload->>'tool';
  IF v_card.sem_chave_cte = true AND v_tool IN ('lancar_ocorrencia', 'lancar_oc_e_enviar_email') THEN
    RAISE EXCEPTION 'Card NF % sem chave fiscal cadastrada (sem_chave_cte=true). RPA OPC 455 ainda não importou. Aguarde alguns minutos ou cadastre chave manual.', v_card.nf
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

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

  -- Caio 2026-05-11 (mig 083): NÃO limpa ia_sugestao_oc_resposta nem
  -- cliente_respondeu_em aqui. Limpeza correta acontece no executor ao
  -- setar state=ACAO_EXECUTADA (sucesso SSW confirmado). Em caso de falha,
  -- reverter_acao_falhou volta pra AVH + lock=true PRESERVANDO contexto da
  -- resposta — Pass A do sync-bastao respeita a exceção clienteJaRespondeu
  -- e não força AGUARDANDO_CLIENTE. Larissa vê card de volta na aba CLIENTE
  -- RESPONDEU com sugestão IA preservada pra tentar outra opção.
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

COMMENT ON FUNCTION public.aprovar_e_executar IS
  'Aprova todo + dispara executor. v4 (Caio 2026-05-11 mig 083): preserva '
  'cliente_respondeu_em e ia_sugestao_oc_resposta — limpeza fica no executor '
  'em caso de sucesso. Em caso de falha, contexto sobrevive pra Pass A.';
