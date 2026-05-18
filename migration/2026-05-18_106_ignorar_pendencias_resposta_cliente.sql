-- ============================================================================
-- Cockpit v2 — RPC ignorar_pendencias_resposta_cliente
-- Data: 2026-05-18
--
-- Quando IA detecta pendências na resposta do cliente (banner laranja "IA
-- DETECTOU PENDÊNCIAS"), o operador hoje vê 2 botões:
--   [✉ RESPONDER CLIENTE]  [IGNORAR E SEGUIR]
--
-- Antes desta migration, "Ignorar e seguir" era PURAMENTE visual (só
-- fechava o banner local). Caso âncora (NF 2305097, Duilio, 2026-05-18):
-- cliente devolveu a pergunta pra Sal Express ("verificar com a área X") —
-- não tem o que responder, só esperar nova resposta. Card ficava preso em
-- CLIENTE RESPONDEU sem ação possível.
--
-- Nova semântica: clicar "Ignorar e seguir" =
--   1. State volta de AGUARDANDO_VALIDACAO_HUMANA → AGUARDANDO_CLIENTE
--   2. cliente_respondeu_em zerado (sai da aba CLIENTE RESPONDEU)
--   3. ia_sugestao_oc_resposta zerado (banner some)
--   4. Mensagem fica visível na aba MENSAGENS (histórico preservado)
--   5. Próxima resposta do cliente nessa thread → vinculador re-aciona
--      normalmente (cliente_respondeu_em volta a ser preenchido)
--
-- Cobrança auto D+4 já é cuidada pelo cron diário (project_cobranca_
-- cliente_aguardando) — esta RPC NÃO mexe em acoes_agendadas.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ignorar_pendencias_resposta_cliente(
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
  v_sugestao_anterior jsonb;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, assigned_operator_id, state, lock_aguardando_validacao,
         cliente_respondeu_em, ia_sugestao_oc_resposta
  INTO v_card FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor'
     AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra ignorar pendências do card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- State de entrada esperado: CLIENTE RESPONDEU (AGUARDANDO_VALIDACAO_HUMANA
  -- + cliente_respondeu_em != null). Se card já saiu desse estado (operador
  -- aprovou outra ação, ou outro evento moveu o card), não faz sentido ignorar.
  IF v_card.state <> 'AGUARDANDO_VALIDACAO_HUMANA' THEN
    RAISE EXCEPTION 'Só funciona quando card está em CLIENTE RESPONDEU (state atual: %)', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_card.cliente_respondeu_em IS NULL THEN
    RAISE EXCEPTION 'Card % não tem resposta de cliente pra ignorar', v_card.id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- lock_aguardando_validacao=true significa que uma ação foi aprovada e
  -- está em execução pelo executor — não pode mexer no state.
  IF v_card.lock_aguardando_validacao = true THEN
    RAISE EXCEPTION 'Card está lockado em execução de ação. Aguarde finalizar.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_sugestao_anterior := v_card.ia_sugestao_oc_resposta;

  UPDATE public.cards
  SET state = 'AGUARDANDO_CLIENTE',
      cliente_respondeu_em = NULL,
      ia_sugestao_oc_resposta = NULL
  WHERE id = p_card_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id,
    'PendenciasRespostaIgnoradas',
    'operator',
    v_operador_id::text,
    jsonb_build_object(
      'motivo', coalesce(p_motivo, '(sem motivo informado)'),
      'state_anterior', 'AGUARDANDO_VALIDACAO_HUMANA',
      'state_novo', 'AGUARDANDO_CLIENTE',
      'cliente_respondeu_em_zerado', v_card.cliente_respondeu_em,
      'ia_sugestao_anterior', v_sugestao_anterior
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', p_card_id,
    'state_novo', 'AGUARDANDO_CLIENTE'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) IS
  'Operador clica "Ignorar e seguir" no banner de pendências IA quando a '
  'resposta do cliente não tem ação possível (ex: cliente devolveu a pergunta). '
  'Card volta pra AGUARDANDO_CLIENTE, sinal cliente_respondeu_em + sugestão IA '
  'são zerados. Próxima resposta do cliente re-aciona o ciclo normalmente.';
