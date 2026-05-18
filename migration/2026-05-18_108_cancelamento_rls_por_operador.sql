-- ============================================================================
-- Cockpit v2 — Cancelamento reentrega: validação por operador (RLS-aware)
-- Data: 2026-05-18
--
-- View v_cancelamentos_reentrega já filtra por operador via INNER JOIN com
-- cards (RLS de cards aplica naturalmente). Mas as ações (forçar
-- cancelamento, marcar tratado) precisam validar acesso ao card antes de
-- executar, porque rodam em SECURITY DEFINER / SERVICE_ROLE e bypassariam
-- RLS sem essa proteção.
--
-- Regra Caio 2026-05-18: cada operador SÓ pode operar cards/cancelamentos
-- de SUA carteira (cliente Duilio = só Duilio; cliente Larissa = só Larissa).
-- Gestor (admin) opera tudo.
--
-- Componentes:
--   1. Atualiza marcar_cancelamento_tratado com check de visibilidade
--   2. Cria forcar_cancelamento_reentrega RPC com check + reset da ação
-- ============================================================================

-- ----- 1. marcar_cancelamento_tratado com check de operador ---------------

CREATE OR REPLACE FUNCTION public.marcar_cancelamento_tratado(
  p_acao_id bigint,
  p_motivo text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_card_id uuid;
  v_assigned_op uuid;
  v_pagador text;
  v_segmento text;
  v_user uuid;
BEGIN
  v_user := auth.uid();

  SELECT aa.card_id, c.assigned_operator_id, c.pagador, c.segmento_codigo
    INTO v_card_id, v_assigned_op, v_pagador, v_segmento
  FROM public.acoes_agendadas aa
  JOIN public.cards c ON c.id = aa.card_id
  WHERE aa.id = p_acao_id AND aa.tipo = 'cancelar_reentrega_ssw';

  IF v_card_id IS NULL THEN
    RAISE EXCEPTION 'Ação % não encontrada ou não é do tipo cancelar_reentrega_ssw', p_acao_id;
  END IF;

  -- Caio 2026-05-18: valida que o operador atual tem acesso ao card.
  -- Reusa a mesma função que a RLS de cards usa pra consistência total.
  IF NOT public.card_visivel_pelo_operador_atual(v_assigned_op, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão pra operar cancelamento de outro operador (acao_id=%)', p_acao_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.acoes_agendadas
  SET
    status = 'tratado_manualmente',
    processed_at = now(),
    payload = payload
      || jsonb_build_object(
        'tratado_em', now()::text,
        'tratado_por', COALESCE(v_user::text, 'sistema'),
        'tratado_motivo', COALESCE(p_motivo, '')
      )
  WHERE id = p_acao_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_card_id,
    'CancelamentoReentregaTratadoManualmente',
    'operator',
    COALESCE(v_user::text, 'sistema'),
    jsonb_build_object('acao_id', p_acao_id, 'motivo', COALESCE(p_motivo, ''))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.marcar_cancelamento_tratado(bigint, text) TO authenticated;

-- ----- 2. forcar_cancelamento_reentrega RPC -------------------------------
-- Operador clica "Forçar agora" na aba — RPC valida acesso e reseta a ação
-- pra executar imediatamente. Depois a edge function dispara o handler.
-- Esta RPC NÃO chama edge function (impossível via SQL); só prepara.

CREATE OR REPLACE FUNCTION public.forcar_cancelamento_reentrega(
  p_acao_id bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_card_id uuid;
  v_assigned_op uuid;
  v_pagador text;
  v_segmento text;
  v_status text;
  v_user uuid;
  v_payload_atual jsonb;
BEGIN
  v_user := auth.uid();

  SELECT aa.card_id, aa.status, aa.payload, c.assigned_operator_id, c.pagador, c.segmento_codigo
    INTO v_card_id, v_status, v_payload_atual, v_assigned_op, v_pagador, v_segmento
  FROM public.acoes_agendadas aa
  JOIN public.cards c ON c.id = aa.card_id
  WHERE aa.id = p_acao_id AND aa.tipo = 'cancelar_reentrega_ssw';

  IF v_card_id IS NULL THEN
    RAISE EXCEPTION 'Ação % não encontrada', p_acao_id;
  END IF;

  IF NOT public.card_visivel_pelo_operador_atual(v_assigned_op, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão pra forçar cancelamento de outro operador (acao_id=%)', p_acao_id
      USING ERRCODE = '42501';
  END IF;

  IF v_status IN ('processado', 'tratado_manualmente') THEN
    RAISE EXCEPTION 'Ação % já está em estado terminal (%)', p_acao_id, v_status;
  END IF;

  -- Reset: status pendente, executar_em=now, tentativas zeradas
  UPDATE public.acoes_agendadas
  SET
    status = 'pendente',
    executar_em = now(),
    processed_at = NULL,
    cancelado_motivo = NULL,
    payload = (v_payload_atual - 'ultima_falha' - 'ultima_falha_em')
      || jsonb_build_object('tentativas', 0, 'forcado_em', now()::text, 'forcado_por', COALESCE(v_user::text, 'sistema'))
  WHERE id = p_acao_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_card_id,
    'ReentregaCancelamentoForcadoPeloOperador',
    'operator',
    COALESCE(v_user::text, 'sistema'),
    jsonb_build_object('acao_id', p_acao_id, 'status_anterior', v_status)
  );

  RETURN jsonb_build_object('ok', true, 'acao_id', p_acao_id, 'status_anterior', v_status);
END;
$$;

GRANT EXECUTE ON FUNCTION public.forcar_cancelamento_reentrega(bigint) TO authenticated;

COMMENT ON FUNCTION public.forcar_cancelamento_reentrega(bigint) IS
  'Caio 2026-05-18: operador clica "Forçar agora" → reset da ação pra cron pegar imediatamente. '
  'Valida acesso via card_visivel_pelo_operador_atual. NÃO invoca handler (edge function faz isso depois).';
