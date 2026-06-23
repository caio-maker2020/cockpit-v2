-- =============================================================================
-- buscar_tratativa_do_card: remove o guard de posse (Caio 2026-06-23).
--
-- BUG: o guard "card não pertence ao operador" rejeitava quando quem clica não é
-- o operador dono do card — ex.: o Caio (admin) clicando "JÁ TEM TRATATIVA" em um
-- card do Duilio → ok:false → toast "Erro ao buscar tratativa", sem nem buscar.
--
-- Por que o guard é desnecessário/errado AQUI: a busca SEMPRE roda no Gmail do
-- operador DONO do card (o edge resolve `card.assigned_operator_id` e carrega as
-- credenciais DELE — scan-email-pre-card L226/241). Quem dispara não muda a caixa
-- pesquisada. O front só mostra o botão em cards visíveis (RLS já gateia). Uso
-- interno single-tenant (ADR 0003). Então: qualquer authenticated que enxerga o
-- card pode disparar; o scan continua na caixa certa. Só registramos quem pediu.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.buscar_tratativa_do_card(p_card_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_operador_id uuid;
  v_existe boolean;
BEGIN
  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();

  SELECT true INTO v_existe FROM public.cards WHERE id = p_card_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'card não encontrado');
  END IF;

  -- scan BROAD (sem thread_hint → busca por NF, pega thread antiga) + contexto
  -- card_em_espera (auto-adota como principal se passar a trava NF+vínculo). A
  -- busca usa SEMPRE o Gmail do operador dono do card (resolvido no edge), não o
  -- de quem disparou — por isso o admin pode disparar sem problema.
  PERFORM pgmq.send('scan_email_pre_card', jsonb_build_object(
    'card_id', p_card_id,
    'contexto', 'card_em_espera',
    'manual', true
  ));

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'BuscaTratativaManualSolicitada', 'operator',
          COALESCE(v_operador_id::text, 'admin'),
          jsonb_build_object('disparado_por_operador', v_operador_id));

  RETURN jsonb_build_object('ok', true, 'enfileirado', true);
END;
$$;
REVOKE ALL ON FUNCTION public.buscar_tratativa_do_card(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buscar_tratativa_do_card(uuid) TO authenticated, service_role;
