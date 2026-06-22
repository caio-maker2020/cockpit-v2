-- =============================================================================
-- Fix: actor_type 'human' é INVÁLIDO em card_events (check só aceita
-- agent/operator/system). As RPCs de decisão da mig 231 quebravam ao inserir o
-- card_event (descartar/adotar). Decisão do operador = 'operator'.
--
-- Caio 2026-06-22: pego ao testar a adoção ao vivo no card 617089
-- ("card_events_actor_type_check" violado). marcar_email_preexistente_visto não
-- insere evento, então não precisa de fix. (Obs: liberar_card_suspeito_lockado
-- da mig 218 tem o mesmo 'human' latente — fora de escopo aqui.)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.descartar_email_preexistente(p_card_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_card uuid;
BEGIN
  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  SELECT assigned_operator_id INTO v_operador_card FROM public.cards WHERE id = p_card_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'card não encontrado');
  END IF;
  IF v_operador_id IS NOT NULL AND v_operador_card IS NOT NULL AND v_operador_card <> v_operador_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'card não pertence ao operador');
  END IF;

  UPDATE public.cards
  SET email_preexistente_sugerido = email_preexistente_sugerido
        || jsonb_build_object('decisao', 'novo', 'decidido_em', now())
  WHERE id = p_card_id
    AND email_preexistente_sugerido IS NOT NULL;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'EmailPreexistenteDescartado', 'operator',
          COALESCE(v_operador_id::text, 'desconhecido'),
          jsonb_build_object('decisao', 'novo'));

  UPDATE public.email_preexistente_scan
  SET resultado = 'descartado', decidido_em = now()
  WHERE card_id = p_card_id;

  RETURN jsonb_build_object('ok', true, 'decisao', 'novo');
END;
$$;
REVOKE ALL ON FUNCTION public.descartar_email_preexistente(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.descartar_email_preexistente(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.adotar_thread_preexistente(
  p_card_id uuid,
  p_gmail_thread_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_card uuid;
  v_existe boolean;
BEGIN
  IF p_gmail_thread_id IS NULL OR length(trim(p_gmail_thread_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'gmail_thread_id obrigatório');
  END IF;

  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  SELECT assigned_operator_id INTO v_operador_card FROM public.cards WHERE id = p_card_id;

  SELECT EXISTS (
    SELECT 1
    FROM public.cards c,
         jsonb_array_elements(COALESCE(c.email_preexistente_sugerido->'candidatos', '[]'::jsonb)) cand
    WHERE c.id = p_card_id
      AND cand->>'gmail_thread_id' = p_gmail_thread_id
  ) INTO v_existe;
  IF NOT v_existe THEN
    RETURN jsonb_build_object('ok', false, 'error', 'thread não está entre os candidatos do card');
  END IF;

  IF v_operador_id IS NOT NULL AND v_operador_card IS NOT NULL AND v_operador_card <> v_operador_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'card não pertence ao operador');
  END IF;

  UPDATE public.cards
  SET email_preexistente_sugerido = email_preexistente_sugerido
        || jsonb_build_object('decisao', 'seguir', 'decidido_em', now(), 'thread_adotada', p_gmail_thread_id)
  WHERE id = p_card_id
    AND email_preexistente_sugerido IS NOT NULL;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'ThreadPreexistenteAdotada', 'operator',
          COALESCE(v_operador_id::text, 'desconhecido'),
          jsonb_build_object('gmail_thread_id', p_gmail_thread_id));

  UPDATE public.email_preexistente_scan
  SET resultado = 'adotado', decidido_em = now()
  WHERE card_id = p_card_id;

  PERFORM pgmq.send('importar_thread_adotada', jsonb_build_object(
    'card_id', p_card_id,
    'gmail_thread_id', p_gmail_thread_id,
    'operador_id', COALESCE(v_operador_card, v_operador_id)
  ));

  RETURN jsonb_build_object('ok', true, 'decisao', 'seguir', 'importacao', 'enfileirada');
END;
$$;
REVOKE ALL ON FUNCTION public.adotar_thread_preexistente(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adotar_thread_preexistente(uuid, text) TO authenticated, service_role;
