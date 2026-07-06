-- =============================================================================
-- 2026-06-26_276 — Enqueue do scan de e-mail pré-existente COM DEDUP (raiz da
--                  fila scan_email_pre_card inflando até 2.235).
--
-- Caio 2026-06-26 (NF 721938, Duilio): a fila tinha 2.235 mensagens mas só 88
-- cards distintos — um card enfileirado 459×. Causa: `surfarThreadDivergenteSeCasar`
-- (gmail-poll, a cada 5min) re-enfileira um scan pra todo e-mail de cliente cujo
-- assunto cita uma NF de card ativo, SEM throttle e SEM dedup. Como o scan fica
-- preso na fila (consome 5/2min) o e-mail nunca vincula → re-enfileira no próximo
-- poll → loop. Isso afoga em FIFO os pedidos reais (nascimento + botão "JÁ TEM
-- TRATATIVA" do operador), gerando ~13h de atraso.
--
-- Auditoria das 7 filas pgmq: SÓ scan_email_pre_card está em loop; as demais
-- (agent_intake/specialist/executor/respostas_envio/importar_thread_adotada) em 0
-- — o gmail-poll já dedup-a o agent_intake por message-id. O furo é exclusivo dos
-- caminhos de enqueue do scan.
--
-- Fix de raiz: enqueue ÚNICO com dedup atômico (advisory lock por card):
--   (1) NÃO empilha se já há job pendente do card na fila  → teto de 1/card;
--   (2) throttle por cooldown (scan recente em email_preexistente_scan) p/ o auto.
-- Todos os caminhos (nascimento, surfar, rescan, botão) passam a usar este enqueue.
-- Guard: verify-cockpit INV-028 (fila sem backlog/duplicação).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- (1) Enqueue dedup'd — fonte ÚNICA de envio pra scan_email_pre_card.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_scan_email_pre_card(
  p_card_id     uuid,
  p_contexto    text    DEFAULT NULL,
  p_thread_hint text    DEFAULT NULL,
  p_nf          text    DEFAULT NULL,
  p_manual      boolean DEFAULT false,
  p_cooldown_min integer DEFAULT 30
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_payload jsonb;
BEGIN
  IF p_card_id IS NULL THEN
    RETURN false;
  END IF;

  -- Serializa por card: duas chamadas concorrentes (2 polls) não furam o dedup.
  PERFORM pg_advisory_xact_lock(hashtext('scan_email_pre_card:' || p_card_id::text));

  -- (a) DEDUP: já existe job pendente desse card na fila → não empilha (teto 1/card).
  --     É o que mata o loop, independente da origem ou de o scan ter rodado.
  IF EXISTS (
    SELECT 1 FROM pgmq.q_scan_email_pre_card
    WHERE (message->>'card_id') = p_card_id::text
  ) THEN
    RETURN false;
  END IF;

  -- (b) THROTTLE (só auto): se já escaneou esse card há pouco, não re-enfileira.
  --     Manual (botão do operador) ignora o cooldown — ele quer agora.
  IF NOT p_manual AND p_cooldown_min > 0 AND EXISTS (
    SELECT 1 FROM public.email_preexistente_scan s
    WHERE s.card_id = p_card_id
      AND s.scaneado_em > now() - make_interval(mins => p_cooldown_min)
  ) THEN
    RETURN false;
  END IF;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'card_id',     p_card_id::text,
    'contexto',    p_contexto,
    'thread_hint', p_thread_hint,
    'nf',          p_nf,
    'manual',      CASE WHEN p_manual THEN true ELSE NULL END
  ));

  PERFORM pgmq.send('scan_email_pre_card', v_payload);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_scan_email_pre_card(uuid, text, text, text, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_scan_email_pre_card(uuid, text, text, text, boolean, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.enqueue_scan_email_pre_card(uuid, text, text, text, boolean, integer) IS
  'Fonte ÚNICA de enqueue pra scan_email_pre_card. Dedup por card (1 pendente máx, '
  'advisory lock) + throttle por cooldown no auto. Caio 2026-06-26 (NF 721938) — '
  'raiz da fila inflando 2.235/88 cards via surfarThreadDivergente sem dedup.';

-- ---------------------------------------------------------------------------
-- (2) Rescan em massa passa a usar o enqueue dedup (defesa: cron hoje inativo,
--     mas se religar não pode floodar de novo). Mantém o WHERE/throttle 12h.
-- ---------------------------------------------------------------------------
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
    WHERE c.state IN ('AGUARDANDO_CLIENTE', 'AGUARDANDO_VALIDACAO_HUMANA')
      AND c.cliente_respondeu_em IS NULL
      AND c.tratativa_email_escolhida IS NULL
      AND c.assigned_operator_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.messages_inbox m WHERE m.card_id = c.id)
      AND (
        c.email_preexistente_sugerido IS NULL
        OR (c.email_preexistente_sugerido->>'decidido_em') IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.email_preexistente_scan s
        WHERE s.card_id = c.id
          AND s.scaneado_em > now() - interval '12 hours'
      )
    ORDER BY c.created_at ASC
    LIMIT GREATEST(p_limit, 0)
  LOOP
    -- dedup'd: nunca empilha 2 do mesmo card.
    IF public.enqueue_scan_email_pre_card(r.id, 'card_em_espera', NULL, NULL, false, 720) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.enfileirar_rescan_cards_aguardando(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enfileirar_rescan_cards_aguardando(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- (3) Botão "JÁ TEM TRATATIVA" (manual) passa a usar o enqueue dedup também.
--     manual=true → ignora cooldown; ainda dedup-a pendência (não empilha).
--     (O front vai além e roda o scan SÍNCRONO — ver prompt Lovable.)
-- ---------------------------------------------------------------------------
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

  PERFORM public.enqueue_scan_email_pre_card(p_card_id, 'card_em_espera', NULL, NULL, true, 0);

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'BuscaTratativaManualSolicitada', 'operator',
          COALESCE(v_operador_id::text, 'admin'),
          jsonb_build_object('disparado_por_operador', v_operador_id));

  RETURN jsonb_build_object('ok', true, 'enfileirado', true);
END;
$$;
REVOKE ALL ON FUNCTION public.buscar_tratativa_do_card(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buscar_tratativa_do_card(uuid) TO authenticated, service_role;
