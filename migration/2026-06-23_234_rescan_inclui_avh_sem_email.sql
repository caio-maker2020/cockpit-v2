-- =============================================================================
-- Re-scan: incluir cards em AGUARDANDO VOCÊ (AVH) sem e-mail rastreado.
--
-- Caio 2026-06-23: o gap não é só AGUARDANDO_CLIENTE. Card âncora NF 146125
-- (Duilio, oc=49, AVH): o Cockpit NUNCA notificou, mas a base OVD abriu thread
-- ("Por qual motivo o cliente recusou? tem a ressalva?") e o Duilio respondeu
-- manual no Gmail — tratativa inteira fora do Cockpit, card com "0 mensagens".
--
-- Amplia a elegibilidade do re-scan p/ AGUARDANDO_CLIENTE + AGUARDANDO_VALIDACAO
-- _HUMANA, restrito aos cards SEM e-mail rastreado (NOT EXISTS messages_inbox) —
-- exatamente os que o Cockpit está cego. Mesma trava/throttle/flag. A distinção
-- de aba (puxar p/ CLIENTE RESPONDEU só no AGUARDANDO_CLIENTE) é no front.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enfileirar_rescan_cards_aguardando(p_limit integer DEFAULT 50)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_on boolean;
  v_count integer := 0;
  r record;
BEGIN
  SELECT enabled INTO v_on FROM public.feature_flags WHERE key = 'scan_email_pre_card_enabled';
  IF NOT COALESCE(v_on, false) THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT c.id
    FROM public.cards c
    WHERE c.state IN ('AGUARDANDO_CLIENTE', 'AGUARDANDO_VALIDACAO_HUMANA')  -- esperando cliente OU você
      AND c.cliente_respondeu_em IS NULL           -- ainda não está em CLIENTE RESPONDEU
      AND c.tratativa_email_escolhida IS NULL      -- nenhuma thread já adotada
      AND c.assigned_operator_id IS NOT NULL       -- precisa de caixa Gmail pra buscar
      AND NOT EXISTS (                             -- Cockpit NÃO rastreia e-mail nesse card
        SELECT 1 FROM public.messages_inbox m WHERE m.card_id = c.id
      )
      AND (                                        -- não decidido ainda
        c.email_preexistente_sugerido IS NULL
        OR (c.email_preexistente_sugerido->>'decidido_em') IS NULL
      )
      AND NOT EXISTS (                             -- throttle: 1 scan / 12h por card
        SELECT 1 FROM public.email_preexistente_scan s
        WHERE s.card_id = c.id
          AND s.scaneado_em > now() - interval '12 hours'
      )
    ORDER BY c.created_at ASC                      -- quem espera há mais tempo primeiro
    LIMIT GREATEST(p_limit, 0)
  LOOP
    PERFORM pgmq.send('scan_email_pre_card', jsonb_build_object(
      'card_id', r.id,
      'contexto', 'card_em_espera'
    ));
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.enfileirar_rescan_cards_aguardando(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enfileirar_rescan_cards_aguardando(integer) TO service_role;

COMMENT ON FUNCTION public.enfileirar_rescan_cards_aguardando(integer) IS
  'Enfileira re-scan (scan_email_pre_card, contexto=card_em_espera) dos cards '
  'AGUARDANDO_CLIENTE ou AGUARDANDO_VALIDACAO_HUMANA SEM e-mail rastreado '
  '(NOT EXISTS messages_inbox). Gated na flag, throttle 12h. Pega thread '
  'divergente que cliente/base abriu e o operador trata fora do Cockpit. '
  'Caio 2026-06-23 (âncora NF 146125).';
