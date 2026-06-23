-- =============================================================================
-- descartar_email_preexistente passa a REVERTER a adoção automática.
--
-- Caio 2026-06-23: como o card_em_espera agora AUTO-ADOTA (puxa thread + seta
-- principal + interpreta), o "Não é deste card / descartar" precisa DESFAZER:
-- apagar o que a feature importou (origem='scan-email-pre-card'), soltar a
-- tratativa/cliente_respondeu e voltar o state. Reverte SÓ o que a feature pôs
-- (preserva respostas reais do gmail-poll). Idempotente.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.descartar_email_preexistente(p_card_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_thr text;
  v_auto boolean;
BEGIN
  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  SELECT email_preexistente_sugerido->>'thread_principal',
         (email_preexistente_sugerido->>'auto')::boolean
    INTO v_thr, v_auto
    FROM public.cards WHERE id = p_card_id;

  IF COALESCE(v_auto, false) THEN
    -- Reverte a adoção automática (só o que a feature importou).
    DELETE FROM public.email_anexos WHERE message_inbox_id IN (
      SELECT id FROM public.messages_inbox
      WHERE card_id = p_card_id AND raw_payload->>'origem' = 'scan-email-pre-card');
    DELETE FROM public.messages_inbox
      WHERE card_id = p_card_id AND raw_payload->>'origem' = 'scan-email-pre-card';
    IF v_thr IS NOT NULL THEN
      DELETE FROM public.cards_emails_outbound
        WHERE card_id = p_card_id AND gmail_thread_id = v_thr;
    END IF;

    UPDATE public.cards c SET
      email_preexistente_sugerido = NULL,
      ia_sugestao_oc_resposta = NULL,
      tratativa_email_escolhida = CASE WHEN c.tratativa_email_escolhida = v_thr THEN NULL ELSE c.tratativa_email_escolhida END,
      cliente_respondeu_em = CASE
        WHEN NOT EXISTS (SELECT 1 FROM public.messages_inbox m WHERE m.card_id = c.id) THEN NULL
        ELSE c.cliente_respondeu_em END,
      lock_aguardando_validacao = CASE
        WHEN c.state = 'AGUARDANDO_VALIDACAO_HUMANA' AND c.cod_ultima_ocorrencia = 54
             AND NOT EXISTS (SELECT 1 FROM public.messages_inbox m WHERE m.card_id = c.id) THEN false
        ELSE c.lock_aguardando_validacao END,
      state = CASE
        WHEN c.state = 'AGUARDANDO_VALIDACAO_HUMANA' AND c.cod_ultima_ocorrencia = 54
             AND NOT EXISTS (SELECT 1 FROM public.messages_inbox m WHERE m.card_id = c.id) THEN 'AGUARDANDO_CLIENTE'
        ELSE c.state END
    WHERE c.id = p_card_id;
  ELSE
    -- Sugestão não-adotada (banner pendente): só marca decidido.
    UPDATE public.cards
    SET email_preexistente_sugerido = email_preexistente_sugerido
          || jsonb_build_object('decisao', 'novo', 'decidido_em', now())
    WHERE id = p_card_id AND email_preexistente_sugerido IS NOT NULL;
  END IF;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'EmailPreexistenteDescartado', 'operator',
          COALESCE(v_operador_id::text, 'desconhecido'),
          jsonb_build_object('revertido', COALESCE(v_auto, false)));

  UPDATE public.email_preexistente_scan
  SET resultado = 'descartado', decidido_em = now() WHERE card_id = p_card_id;

  RETURN jsonb_build_object('ok', true, 'revertido', COALESCE(v_auto, false));
END;
$$;
REVOKE ALL ON FUNCTION public.descartar_email_preexistente(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.descartar_email_preexistente(uuid) TO authenticated, service_role;
