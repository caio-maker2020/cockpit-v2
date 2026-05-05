-- ============================================================================
-- Cockpit v2 — RPC marcar_card_nao_importante (TRATATIVA_PENDENTE → CANCELADO)
-- Data: 2026-05-04
--
-- Quando card está em TRATATIVA_PENDENTE (cliente cobrou sobre NF que saiu pra
-- outro setor, ou re-aparece no Bastão fora de relacionamento), Larissa pode
-- clicar "Não importante" → card vai pra CANCELADO e some da plataforma.
--
-- Alternativa = Larissa não clica nada e card fica em TRATATIVA_PENDENTE até
-- ela decidir acompanhar/agir manualmente.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.marcar_card_nao_importante(
  p_card_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_card record;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, assigned_operator_id, state, nf, cod_ultima_ocorrencia
  INTO v_card FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor'
     AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra marcar card %', p_card_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Aceita TRATATIVA_PENDENTE ou TRANSFERIDO (caso operadora veja card
  -- transferido na timeline e queira limpar).
  IF v_card.state NOT IN ('TRATATIVA_PENDENTE', 'TRANSFERIDO') THEN
    RAISE EXCEPTION 'Só funciona em TRATATIVA_PENDENTE ou TRANSFERIDO (atual: %)', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.cards SET state = 'CANCELADO' WHERE id = p_card_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id,
    'CardMarcadoComoNaoImportante',
    'operator',
    v_operador_id::text,
    jsonb_build_object(
      'motivo', coalesce(p_motivo, '(sem motivo)'),
      'state_anterior', v_card.state,
      'state_novo', 'CANCELADO',
      'nf', v_card.nf,
      'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia
    )
  );

  RETURN jsonb_build_object('ok', true, 'card_id', p_card_id, 'state_novo', 'CANCELADO');
END;
$$;

REVOKE ALL ON FUNCTION public.marcar_card_nao_importante(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_card_nao_importante(uuid, text) TO authenticated;
