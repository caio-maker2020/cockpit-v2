-- ============================================================================
-- Cockpit v2 — RPC marcar_retorno_inconclusivo
-- Data: 2026-05-01
--
-- Quando cliente responde mas resposta não resolve a pergunta original
-- ("ok obrigado", "vou verificar"), o vinculador moveu o card pra
-- AGUARDANDO_AGENTE automaticamente. Larissa quer marcar manualmente
-- "isso não foi retorno válido" e reiniciar o relógio dos 4 dias.
--
-- Comportamento:
--  1. Move card de AGUARDANDO_AGENTE → AGUARDANDO_CLIENTE
--  2. Cancela acoes_agendadas pendentes (limpa relógio antigo)
--  3. Agenda nova cobrança em D+4 com template COBRANCA_LEMBRETE
--  4. Registra card_event 'RetornoMarcadoComoInconclusivo'
-- ============================================================================

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
  v_canc int;
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
    RAISE EXCEPTION 'Sem permissão pra marcar retorno do card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_card.state <> 'AGUARDANDO_AGENTE' THEN
    RAISE EXCEPTION 'Só funciona quando card está em AGUARDANDO_AGENTE (atual: %)', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_card.lock_aguardando_validacao = true THEN
    RAISE EXCEPTION 'Card está lockado em validação humana. Use Aprovar/Voltar/Rejeitar primeiro.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 1. Cancela ações agendadas pendentes (relógio antigo)
  WITH canc AS (
    UPDATE public.acoes_agendadas
    SET status = 'cancelado',
        cancelado_motivo = 'retorno marcado como inconclusivo'
    WHERE card_id = p_card_id AND status = 'pendente'
    RETURNING 1
  )
  SELECT count(*) INTO v_canc FROM canc;

  -- 2. Move card pra AGUARDANDO_CLIENTE
  UPDATE public.cards
  SET state = 'AGUARDANDO_CLIENTE'
  WHERE id = p_card_id;

  -- 3. Agenda nova cobrança em D+4
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

  -- 4. Audit
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id,
    'RetornoMarcadoComoInconclusivo',
    'operator',
    v_operador_id::text,
    jsonb_build_object(
      'motivo', coalesce(p_motivo, '(sem motivo)'),
      'acoes_canceladas', v_canc,
      'nova_acao_agendada_id', v_nova_acao,
      'reagendado_para', now() + interval '4 days',
      'state_anterior', 'AGUARDANDO_AGENTE',
      'state_novo', 'AGUARDANDO_CLIENTE'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', p_card_id,
    'acoes_canceladas', v_canc,
    'nova_cobranca_em', now() + interval '4 days'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.marcar_retorno_inconclusivo(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_retorno_inconclusivo(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.marcar_retorno_inconclusivo(uuid, text) IS
  'Operadora marca que a resposta do cliente não foi conclusiva. Card volta pra '
  'AGUARDANDO_CLIENTE, cobranças antigas são canceladas, nova cobrança automática '
  'agendada em D+4. Usado quando cliente responde "ok obrigado" sem resolver a '
  'pergunta original.';
