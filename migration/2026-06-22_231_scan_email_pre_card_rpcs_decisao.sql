-- =============================================================================
-- RPCs de decisão do operador sobre a sugestão de e-mail pré-existente.
--
-- Caio 2026-06-22. Molde: marcar_mudanca_suspeita_vista / liberar_card_suspeito
-- _lockado (mig 218). SECURITY DEFINER traduz auth.uid()→operadores.id (FK 23503
-- se usar uid direto). Toda decisão vira card_event (event sourcing).
--
--   - marcar_email_preexistente_visto  → snooze (some o banner, sem decidir).
--   - descartar_email_preexistente     → "Abrir e-mail novo" (decisao='novo').
--   - adotar_thread_preexistente       → "Seguir nesta thread" (decisao='seguir')
--       + enfileira importar_thread_adotada (importação pesada no edge).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Snooze: marca vista_em (some o banner). Não decide nada.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.marcar_email_preexistente_visto(p_card_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
BEGIN
  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  UPDATE public.cards
  SET email_preexistente_sugerido = email_preexistente_sugerido || jsonb_build_object('vista_em', now())
  WHERE id = p_card_id
    AND (assigned_operator_id = v_operador_id OR v_operador_id IS NULL)
    AND email_preexistente_sugerido IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.marcar_email_preexistente_visto(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_email_preexistente_visto(uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. "Abrir e-mail novo": descarta a sugestão. Operador segue no fluxo normal
--    (abre e-mail novo pelo Cockpit). decisao='novo' + card_event.
-- ----------------------------------------------------------------------------
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
  VALUES (p_card_id, 'EmailPreexistenteDescartado', 'human',
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

-- ----------------------------------------------------------------------------
-- 3. "Seguir nesta thread": adota a thread pré-existente. Valida que o thread
--    está entre os candidatos do card, grava decisao='seguir' + card_event, e
--    ENFILEIRA a importação pesada (importar_thread_adotada) — o edge
--    scan-email-pre-card importa o histórico, ancora o thread_id e seta
--    cards.tratativa_email_escolhida (Fase 5). Aqui NÃO chama Gmail.
-- ----------------------------------------------------------------------------
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

  -- valida que o thread realmente foi sugerido pra esse card (anti-spoof)
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
  VALUES (p_card_id, 'ThreadPreexistenteAdotada', 'human',
          COALESCE(v_operador_id::text, 'desconhecido'),
          jsonb_build_object('gmail_thread_id', p_gmail_thread_id));

  UPDATE public.email_preexistente_scan
  SET resultado = 'adotado', decidido_em = now()
  WHERE card_id = p_card_id;

  -- importação pesada (histórico + ancoragem + tratativa_email_escolhida) no edge
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
