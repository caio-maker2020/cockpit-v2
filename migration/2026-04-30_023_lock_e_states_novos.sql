-- ============================================================================
-- Cockpit v2 — Lock de validação humana + states TRANSFERIDO/TRATATIVA_PENDENTE
-- Data: 2026-04-30
--
-- Mudanças:
-- 1. Coluna `cards.lock_aguardando_validacao` (bool) — quando true, sync-bastao
--    NÃO mexe no state do card (mesmo que oc no Bastão mude). Só sai do lock
--    via aprovar_e_executar / rejeitar_acao / auto_aprovar_e_executar.
--    Resolve o problema de card que foi pra "AGUARDANDO VALIDAÇÃO HUMANA"
--    voltar pra "AGUARDANDO CLIENTE" no próximo sync se a oc 54 ainda existir.
--
-- 2. Renome semântico: Pass B do sync-bastao parava cards em state='RESOLVIDO'
--    quando a oc saía do escopo do relacionamento. Mas RESOLVIDO é "fim de
--    fato". Vamos usar `TRANSFERIDO` pra cards que saíram pra outro setor.
--    O setor destino vai num card_event `DevolvidoParaSetor` (não numa coluna
--    nova, pra evitar explosão de states tipo TRANSFERIDO_OPERACAO,
--    TRANSFERIDO_DEVOLUCAO, etc).
--
-- 3. State `TRATATIVA_PENDENTE`: quando card está em TRANSFERIDO e cliente
--    cobra de novo (via email/whatsapp), vinculador detecta e muda pra cá.
--    Coluna nova no Kanban "TRATATIVA PENDENTE".
--
-- 4. RPCs `aprovar_e_executar` e `rejeitar_acao` atualizadas pra destravar
--    o lock. `rejeitar_acao` ganha lógica de "seguir última ocorrência":
--    seta state do card baseado em cod_ultima_ocorrencia, lendo o setor
--    de `ocorrencias_dicionario`.
-- ============================================================================

-- ============================================================================
-- Coluna nova: lock_aguardando_validacao
-- ============================================================================
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS lock_aguardando_validacao boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_cards_lock_aguardando_validacao
  ON public.cards(lock_aguardando_validacao)
  WHERE lock_aguardando_validacao = true;

COMMENT ON COLUMN public.cards.lock_aguardando_validacao IS
  'Lock de validação humana. Quando true, sync-bastao NÃO mexe no state do '
  'card (mesmo que oc no Bastão mude). Setado pelo vinculador quando agente '
  'puxa card pra AGUARDANDO_VALIDACAO_HUMANA. Destravado por aprovar_e_executar, '
  'rejeitar_acao ou auto_aprovar_e_executar. Garante que card só sai dessa aba '
  'após decisão humana explícita.';

-- ============================================================================
-- aprovar_e_executar — destrava lock + seta aprovacao_modo='humana'
-- ============================================================================
CREATE OR REPLACE FUNCTION public.aprovar_e_executar(p_todo_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_todo record;
  v_card record;
  v_msg_id bigint;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, card_id, action_id, proposta_payload, status
  INTO v_todo FROM public.todos WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_todo.status <> 'pendente' THEN
    RAISE EXCEPTION 'Todo % já em status=%', p_todo_id, v_todo.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, assigned_operator_id, state, nf, ctrc INTO v_card
  FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  IF v_operador_papel <> 'gestor' AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra aprovar todo do card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id, 'AprovacaoOperador', 'operator', v_operador_id::text,
    jsonb_build_object(
      'todo_id', p_todo_id, 'action_id', v_todo.action_id,
      'proposta_payload', v_todo.proposta_payload
    )
  );

  UPDATE public.todos
  SET status = 'aprovado', approved_by = v_operador_id, approved_at = now()
  WHERE id = p_todo_id;

  -- Aprovação destrava lock + marca aprovação humana + state passa pra
  -- EXECUTANDO_ACAO. Próximo sync-bastao acompanha (Pass C).
  UPDATE public.cards
  SET aprovacao_modo = 'humana',
      lock_aguardando_validacao = false,
      state = 'EXECUTANDO_ACAO'
  WHERE id = v_todo.card_id;

  v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
    'todo_id', p_todo_id, 'card_id', v_todo.card_id,
    'action_id', v_todo.action_id, 'proposta_payload', v_todo.proposta_payload,
    'aprovado_por', v_operador_id, 'card_nf', v_card.nf, 'card_ctrc', v_card.ctrc
  ));

  RETURN jsonb_build_object('ok', true, 'todo_id', p_todo_id,
                            'card_id', v_todo.card_id, 'pgmq_msg_id', v_msg_id);
END;
$$;

REVOKE ALL ON FUNCTION public.aprovar_e_executar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aprovar_e_executar(uuid) TO authenticated;

-- ============================================================================
-- rejeitar_acao — destrava lock + "seguir última ocorrência"
-- Lê cod_ultima_ocorrencia do card e mapeia pra state coerente:
--   - 54 (Cliente)                          → AGUARDANDO_CLIENTE
--   - oc de Relacionamento (do dicionário)  → AGUARDANDO_AGENTE
--   - oc fora de Relacionamento/Cliente     → TRANSFERIDO
--   - sem cod_ultima_ocorrencia             → AGUARDANDO_AGENTE (default)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rejeitar_acao(
  p_todo_id uuid,
  p_motivo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_todo record;
  v_card record;
  v_responsabilidade text;
  v_new_state text;
BEGIN
  IF length(trim(coalesce(p_motivo, ''))) < 3 THEN
    RAISE EXCEPTION 'Motivo da rejeição obrigatório (mínimo 3 chars)';
  END IF;

  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado';
  END IF;

  SELECT id, card_id, action_id, status INTO v_todo
  FROM public.todos WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id;
  END IF;

  IF v_todo.status <> 'pendente' THEN
    RAISE EXCEPTION 'Todo % já em status=%', p_todo_id, v_todo.status;
  END IF;

  SELECT id, assigned_operator_id, cod_ultima_ocorrencia INTO v_card
  FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  IF v_operador_papel <> 'gestor' AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra rejeitar';
  END IF;

  -- Mapeia cod_ultima_ocorrencia → state usando o dicionário
  IF v_card.cod_ultima_ocorrencia IS NULL THEN
    v_new_state := 'AGUARDANDO_AGENTE';
  ELSE
    SELECT responsabilidade INTO v_responsabilidade
    FROM public.ocorrencias_dicionario
    WHERE codigo = v_card.cod_ultima_ocorrencia;

    v_new_state := CASE
      WHEN v_responsabilidade = 'Cliente'        THEN 'AGUARDANDO_CLIENTE'
      WHEN v_responsabilidade = 'Relacionamento' THEN 'AGUARDANDO_AGENTE'
      WHEN v_responsabilidade IS NULL            THEN 'AGUARDANDO_AGENTE'
      ELSE                                            'TRANSFERIDO'
    END;
  END IF;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id, 'RejeicaoOperador', 'operator', v_operador_id::text,
    jsonb_build_object(
      'todo_id', p_todo_id, 'action_id', v_todo.action_id,
      'motivo', p_motivo, 'new_state', v_new_state,
      'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia,
      'responsabilidade_oc', v_responsabilidade
    )
  );

  UPDATE public.todos
  SET status = 'rejeitado', approved_by = v_operador_id,
      approved_at = now(), rejection_reason = p_motivo
  WHERE id = p_todo_id;

  -- Rejeição destrava lock + manda card pro state coerente com a oc atual
  UPDATE public.cards
  SET state = v_new_state,
      lock_aguardando_validacao = false
  WHERE id = v_todo.card_id;

  RETURN jsonb_build_object(
    'ok', true, 'todo_id', p_todo_id,
    'new_state', v_new_state, 'motivo_state', v_responsabilidade
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rejeitar_acao(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rejeitar_acao(uuid, text) TO authenticated;

-- ============================================================================
-- auto_aprovar_e_executar — destrava lock (defensivo, embora auto-aprovação
-- não passe por AGUARDANDO_VALIDACAO_HUMANA)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.auto_aprovar_e_executar(
  p_todo_id uuid,
  p_regra text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_todo record;
  v_card record;
  v_msg_id bigint;
BEGIN
  IF p_regra IS NULL OR length(trim(p_regra)) = 0 THEN
    RAISE EXCEPTION 'Regra de auto-aprovação obrigatória';
  END IF;

  SELECT id, card_id, action_id, proposta_payload, status
  INTO v_todo FROM public.todos WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_todo.status <> 'pendente' THEN
    RAISE EXCEPTION 'Todo % já em status=%', p_todo_id, v_todo.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, nf, ctrc INTO v_card FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id, 'AutoAprovacaoPermitida', 'system', 'vinculador',
    jsonb_build_object(
      'todo_id', p_todo_id, 'action_id', v_todo.action_id,
      'regra', p_regra, 'proposta_payload', v_todo.proposta_payload
    )
  );

  UPDATE public.todos
  SET status = 'aprovado', approved_by = NULL, approved_at = now(),
      auto_approval_rule = p_regra
  WHERE id = p_todo_id;

  UPDATE public.cards
  SET aprovacao_modo = 'autonoma',
      lock_aguardando_validacao = false,
      state = 'EXECUTANDO_ACAO'
  WHERE id = v_todo.card_id;

  v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
    'todo_id', p_todo_id, 'card_id', v_todo.card_id, 'action_id', v_todo.action_id,
    'proposta_payload', v_todo.proposta_payload,
    'aprovado_por', NULL, 'auto_approval_rule', p_regra,
    'card_nf', v_card.nf, 'card_ctrc', v_card.ctrc
  ));

  RETURN jsonb_build_object('ok', true, 'todo_id', p_todo_id,
                            'card_id', v_todo.card_id,
                            'regra', p_regra, 'pgmq_msg_id', v_msg_id);
END;
$$;

REVOKE ALL ON FUNCTION public.auto_aprovar_e_executar(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_aprovar_e_executar(uuid, text) TO service_role;
