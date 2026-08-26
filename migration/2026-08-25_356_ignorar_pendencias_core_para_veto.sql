-- =============================================================================
-- 2026-08-25_356_ignorar_pendencias_core_para_veto.sql
--
-- ETAPA D/E do plano de veto (Caio 25/08): "sugerir aguardar" também é ação
-- autônoma com janela — no vencimento o motor executa o "ignorar e continuar
-- aguardando". A RPC ignorar_pendencias_resposta_cliente (mig 287) exige
-- auth.uid() (operador logado) e o processador roda como service_role.
--
-- FIX NA RAIZ (sem duplicar a lógica INV-019): extrai o CORE pra
-- ignorar_pendencias_core(p_card_id, p_motivo, p_actor_type, p_actor_id) e a
-- função pública autenticada vira um wrapper fino (auth + permissão + core).
-- Comportamento do operador: byte a byte o de antes (mesmos guards, mesmos
-- eventos, mesmo retorno). O core é service_role-only.
--
-- SEM begin/commit interno. Idempotente.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ignorar_pendencias_core(
  p_card_id uuid,
  p_motivo text,
  p_actor_type text,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_card record;
  v_sugestao_anterior jsonb;
  v_deve_manter_avh boolean;
  v_state_novo text;
  v_lock_novo boolean;
BEGIN
  SELECT id, assigned_operator_id, state, lock_aguardando_validacao,
         cliente_respondeu_em, ia_sugestao_oc_resposta,
         cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia
  INTO v_card FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_card.state <> 'AGUARDANDO_VALIDACAO_HUMANA' THEN
    RAISE EXCEPTION 'Só funciona quando card está em CLIENTE RESPONDEU (state atual: %)', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_card.cliente_respondeu_em IS NULL THEN
    RAISE EXCEPTION 'Card % não tem resposta de cliente pra ignorar', v_card.id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_card.state IN ('EXECUTANDO_ACAO', 'EM_EXECUCAO_AUTOMATICA', 'ACAO_EXECUTADA') THEN
    RAISE EXCEPTION 'Card está em execução de ação (state=%). Aguarde finalizar.', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_sugestao_anterior := v_card.ia_sugestao_oc_resposta;

  -- GUARD INV-019 (idêntico à mig 287 — fato verificado, bug NF 1119469)
  v_deve_manter_avh := (
    v_card.cod_ultima_ocorrencia IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52)
    AND NOT EXISTS (
      SELECT 1 FROM public.acoes_executadas_ssw a
      WHERE a.card_id = p_card_id
        AND a.codigo_oc = 54
        AND a.sucesso
        AND (a.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
            >= v_card.bastao_data_ultima_ocorrencia
    )
  );

  IF v_deve_manter_avh THEN
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
      p_actor_type,
      p_actor_id,
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
        'observacao', 'oc de relacionamento ≠54: card não pode ir pra AGUARDANDO_CLIENTE. Fica em AGUARDANDO VOCÊ (AVH+lock) até a operadora lançar a ocorrência.'
      )
    );
  ELSE
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
      p_actor_type,
      p_actor_id,
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
    'permaneceu_em_aguardando_voce', v_deve_manter_avh,
    'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ignorar_pendencias_core(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ignorar_pendencias_core(uuid, text, text, text) TO service_role;

COMMENT ON FUNCTION public.ignorar_pendencias_core IS
  'Core do "ignorar e continuar aguardando" (lógica INV-019 da mig 287) sem '
  'auth — actor vem por parâmetro. Chamado pelo wrapper autenticado (operador) '
  'e pelo motor da janela de veto (aguardar autônomo, plano 25/08).';

-- Wrapper autenticado: mesmo nome/assinatura/retorno de sempre.
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
  v_assigned uuid;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT assigned_operator_id INTO v_assigned FROM public.cards WHERE id = p_card_id;
  IF v_assigned IS NULL AND NOT EXISTS (SELECT 1 FROM public.cards WHERE id = p_card_id) THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor' AND v_assigned IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra ignorar pendências do card %', p_card_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN public.ignorar_pendencias_core(p_card_id, p_motivo, 'operator', v_operador_id::text);
END;
$$;

REVOKE ALL ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) TO authenticated;
