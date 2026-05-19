-- ============================================================================
-- Cockpit v2 — ignorar_pendencias_resposta_cliente aceita lock=true
-- Data: 2026-05-19
--
-- Bug NF 868963 (Duilio): operador clicou "IGNORAR E SEGUIR" mas RPC rejeitou
-- com "Card está lockado em execução de ação". O card NÃO está em execução —
-- está em AGUARDANDO_VALIDACAO_HUMANA porque o vinculador setou lock=true
-- quando o cliente respondeu (forçar validação humana, não execução).
--
-- A guarda original confundia 2 conceitos diferentes de lock:
--   (a) lock real de execução: state ∈ EXECUTANDO_ACAO / EM_EXECUCAO_AUTOMATICA
--       / ACAO_EXECUTADA (executor está rodando, não pode mexer)
--   (b) lock de validação humana: vinculador setou pra forçar Larissa/Duilio
--       a olhar antes do sync mover o card. NÃO bloqueia ignorar.
--
-- Fix: substitui guarda `lock_aguardando_validacao=true` por checagem de state.
-- E o UPDATE agora também zera lock pra deixar o card limpo em AGUARDANDO_CLIENTE.
--
-- 3 cards atualmente afetados (state=AGUARDANDO_VALIDACAO_HUMANA + lock=true +
-- cliente_respondeu_em != null): NFs 868963 (Duilio), 15595 (Duilio), 351077
-- (Larissa). Backfill manual destravado fica a critério do operador clicar.
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

  IF v_card.state <> 'AGUARDANDO_VALIDACAO_HUMANA' THEN
    RAISE EXCEPTION 'Só funciona quando card está em CLIENTE RESPONDEU (state atual: %)', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_card.cliente_respondeu_em IS NULL THEN
    RAISE EXCEPTION 'Card % não tem resposta de cliente pra ignorar', v_card.id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Caio 2026-05-19 (bug NF 868963): a guarda anterior bloqueava
  -- lock_aguardando_validacao=true entendendo isso como "execução em curso".
  -- Mas o vinculador também seta lock=true quando cliente responde (forçar
  -- validação humana, não execução). O lock real de execução está refletido
  -- pelo state. Checa state explicitamente.
  IF v_card.state IN ('EXECUTANDO_ACAO', 'EM_EXECUCAO_AUTOMATICA', 'ACAO_EXECUTADA') THEN
    RAISE EXCEPTION 'Card está em execução de ação (state=%). Aguarde finalizar.', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_sugestao_anterior := v_card.ia_sugestao_oc_resposta;

  -- Zera lock junto com cliente_respondeu_em + sugestão. Card volta limpo
  -- pra AGUARDANDO_CLIENTE — próxima resposta do cliente re-aciona o ciclo.
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
      'state_anterior', 'AGUARDANDO_VALIDACAO_HUMANA',
      'state_novo', 'AGUARDANDO_CLIENTE',
      'lock_anterior', v_card.lock_aguardando_validacao,
      'cliente_respondeu_em_zerado', v_card.cliente_respondeu_em,
      'ia_sugestao_anterior', v_sugestao_anterior
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', p_card_id,
    'state_novo', 'AGUARDANDO_CLIENTE',
    'lock_zerado', v_card.lock_aguardando_validacao
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) IS
  'Caio 2026-05-19 v2: aceita lock_aguardando_validacao=true (lock de validação '
  'humana, não de execução). Guarda real agora é o state (EXECUTANDO_ACAO etc). '
  'UPDATE zera o lock junto com cliente_respondeu_em + ia_sugestao_oc_resposta.';
