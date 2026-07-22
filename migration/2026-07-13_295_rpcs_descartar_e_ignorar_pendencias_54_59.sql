-- ============================================================================
-- Cockpit v2 — RPCs descartar_email_preexistente + ignorar_pendencias_resposta_cliente
--                aceitam a oc de CLIENTE {54,59} (separação 54/59)
-- Data: 2026-07-13 (Caio — separação 54/59, Bloco 7)
-- skill: supabase-postgres-best-practices
--
-- CONTEXTO: com a 59 (RETORNO INDENIZAÇÃO) residindo em AGUARDANDO_CLIENTE igual
-- à 54, duas RPCs LIVE ficaram 54-only e travariam um card 59:
--
--   (1) descartar_email_preexistente (mig 236): quando o scan-email-pre-card
--       AUTO-ADOTA um card (AGUARDANDO_CLIENTE → AVH+lock) e a operadora clica
--       "descartar", os DOIS CASE (lock_aguardando_validacao + state) só revertem
--       cod_ultima_ocorrencia = 54. Um card 59 cairia no ELSE → PRESO em
--       AGUARDANDO_VALIDACAO_HUMANA + lock permanente (nenhum watchdog cobre;
--       reconciliar_execucoes_presas só trata EXECUTANDO_ACAO). Fix: IN (54,59).
--
--   (2) ignorar_pendencias_resposta_cliente (mig 287): a exceção de LAG do guard
--       INV-019 confere `a.codigo_oc = 54` — se o Cockpit lançou 59 mas o Bastão
--       ainda mostra a oc de relacionamento anterior (lag), a RPC não reconhece o
--       lançamento de 59 e mantém o card em AVH indevidamente. Fix: IN (54,59).
--
-- Nada além do predicado muda (SECURITY DEFINER, search_path, GRANTs, eventos,
-- backfill histórico — tudo idêntico). NÃO há backfill novo: não existe card 59
-- em produção ainda (feature não deployada). O `= 54` do backfill da mig 287
-- estava correto no momento (não havia 59).
--
-- skill checklist:
--   - CREATE OR REPLACE idempotente ✓
--   - SECURITY DEFINER + SET search_path = public preservados ✓
--   - REVOKE/GRANT reafirmados junto (RLS/permorm) ✓
--   - EXISTS usa índice UNIQUE acoes_executadas_ssw(card_id,codigo_oc,ctrc) — seek ✓
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) descartar_email_preexistente — reverte adoção automática também pra oc 59.
--     Idêntica à mig 236, exceto os 2 predicados cod_ultima_ocorrencia = 54 → IN (54,59).
-- ----------------------------------------------------------------------------
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
      -- Caio 2026-07-13 (separação 54/59): {54,59} são as ocs de cliente que residem
      -- em AGUARDANDO_CLIENTE — a reversão da adoção destrava/devolve as DUAS.
      lock_aguardando_validacao = CASE
        WHEN c.state = 'AGUARDANDO_VALIDACAO_HUMANA' AND c.cod_ultima_ocorrencia IN (54,59)
             AND NOT EXISTS (SELECT 1 FROM public.messages_inbox m WHERE m.card_id = c.id) THEN false
        ELSE c.lock_aguardando_validacao END,
      state = CASE
        WHEN c.state = 'AGUARDANDO_VALIDACAO_HUMANA' AND c.cod_ultima_ocorrencia IN (54,59)
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

-- ----------------------------------------------------------------------------
-- (2) ignorar_pendencias_resposta_cliente — exceção de LAG do INV-019 reconhece
--     lançamento de 59 além de 54. Idêntica à mig 287, exceto a.codigo_oc = 54 → IN (54,59).
-- ----------------------------------------------------------------------------
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
  v_deve_manter_avh boolean;
  v_state_novo text;
  v_lock_novo boolean;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, assigned_operator_id, state, lock_aguardando_validacao,
         cliente_respondeu_em, ia_sugestao_oc_resposta,
         cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia
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

  IF v_card.state <> 'AGUARDANDO_VALIDACAO_HUMANA' THEN
    RAISE EXCEPTION 'Só funciona quando card está em CLIENTE RESPONDEU (state atual: %)', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_card.cliente_respondeu_em IS NULL THEN
    RAISE EXCEPTION 'Card % não tem resposta de cliente pra ignorar', v_card.id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock aqui é lock de VALIDAÇÃO HUMANA (vinculador setou quando cliente
  -- respondeu), não de execução. O lock de execução real está no state.
  IF v_card.state IN ('EXECUTANDO_ACAO', 'EM_EXECUCAO_AUTOMATICA', 'ACAO_EXECUTADA') THEN
    RAISE EXCEPTION 'Card está em execução de ação (state=%). Aguarde finalizar.', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_sugestao_anterior := v_card.ia_sugestao_oc_resposta;

  -- GUARD INV-019 (fato verificado — bug NF 1119469): predicado IDÊNTICO ao
  -- /verify-cockpit. O card só PODE deixar de ir pra AGUARDANDO_CLIENTE quando é
  -- oc de RELACIONAMENTO ≠{54,59} E não está em lag pós-lançamento de cliente.
  -- Caio 2026-07-13 (separação 54/59): a exceção de lag reconhece lançamento de
  -- 54 OU 59 (ambas põem o card em AGUARDANDO_CLIENTE). Sem o 59, um card cujo
  -- Cockpit lançou 59 e cujo Bastão ainda laga na oc anterior ficaria preso em AVH.
  v_deve_manter_avh := (
    v_card.cod_ultima_ocorrencia IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52)
    AND NOT EXISTS (
      SELECT 1 FROM public.acoes_executadas_ssw a
      WHERE a.card_id = p_card_id
        AND a.codigo_oc IN (54,59)
        AND a.sucesso
        AND (a.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
            >= v_card.bastao_data_ultima_ocorrencia
    )
  );

  IF v_deve_manter_avh THEN
    -- oc de relacionamento ≠{54,59}: NÃO pode ir pra AGUARDANDO_CLIENTE (INV-019).
    -- Fica em AGUARDANDO VOCÊ (AVH+lock). Limpa os sinais de "cliente respondeu"
    -- pra sair da aba CLIENTE RESPONDEU, mas o operador ainda precisa LANÇAR a oc.
    v_state_novo := 'AGUARDANDO_VALIDACAO_HUMANA';
    v_lock_novo := true;

    UPDATE public.cards
    SET state = 'AGUARDANDO_VALIDACAO_HUMANA',
        lock_aguardando_validacao = true,
        cliente_respondeu_em = NULL,
        ia_sugestao_oc_resposta = NULL
    WHERE id = p_card_id;

    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (
      p_card_id,
      'PendenciasRespostaIgnoradasMantidoEmAguardandoVoce',
      'operator',
      v_operador_id::text,
      jsonb_build_object(
        'motivo', coalesce(p_motivo, '(sem motivo informado)'),
        'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia,
        'state_anterior', 'AGUARDANDO_VALIDACAO_HUMANA',
        'state_novo', 'AGUARDANDO_VALIDACAO_HUMANA',
        'lock_anterior', v_card.lock_aguardando_validacao,
        'lock_novo', true,
        'cliente_respondeu_em_zerado', v_card.cliente_respondeu_em,
        'ia_sugestao_anterior', v_sugestao_anterior,
        'regra', 'INV-019',
        'observacao', 'oc de relacionamento ≠{54,59}: card não pode ir pra AGUARDANDO_CLIENTE. Fica em AGUARDANDO VOCÊ (AVH+lock) até a operadora lançar a ocorrência.'
      )
    );
  ELSE
    -- oc∈{54,59}, lag pós-cliente, ou fora de escopo → AGUARDANDO_CLIENTE
    -- (comportamento atual preservado). Card volta limpo; próxima resposta re-aciona.
    v_state_novo := 'AGUARDANDO_CLIENTE';
    v_lock_novo := false;

    UPDATE public.cards
    SET state = 'AGUARDANDO_CLIENTE',
        lock_aguardando_validacao = false,
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
        'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia,
        'state_anterior', 'AGUARDANDO_VALIDACAO_HUMANA',
        'state_novo', 'AGUARDANDO_CLIENTE',
        'lock_anterior', v_card.lock_aguardando_validacao,
        'cliente_respondeu_em_zerado', v_card.cliente_respondeu_em,
        'ia_sugestao_anterior', v_sugestao_anterior
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', p_card_id,
    'state_novo', v_state_novo,
    'lock_novo', v_lock_novo,
    -- front usa isso pra avisar a operadora que o card NÃO saiu de AGUARDANDO
    -- VOCÊ (oc de relacionamento ≠{54,59} — invariante oc de cliente ⟺ AGUARDANDO_CLIENTE).
    'permaneceu_em_aguardando_voce', v_deve_manter_avh,
    'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) IS
  'Caio 2026-07-13 v4 (separação 54/59): respeita INV-019 com a oc de cliente {54,59}. '
  'Só move p/ AGUARDANDO_CLIENTE quando oc∈{54,59}, lag pós-cliente, ou fora de escopo. '
  'Oc de relacionamento ≠{54,59} (3,8,10,11,17,19,20,23,26,28,35,43,49,52 sem lag) FICA '
  'em AGUARDANDO_VALIDACAO_HUMANA + lock=true. Predicado idêntico ao /verify-cockpit INV-019.';
