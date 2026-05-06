-- ============================================================================
-- Cockpit v2 — RPC auto_lancar_oc56_sem_evidencia
-- Data: 2026-05-06
--
-- Regra Caio 2026-05-06: cards criados com oc=10/11/35 sem foto anexada no SSW
-- (operação esqueceu de tirar evidência) devem disparar oc=56 (falta info
-- operacional) AUTONOMAMENTE, sem aprovação humana. Card vai pra
-- aprovacao_modo='autonoma' → Pass A próximo sync detecta oc=56 → TRANSFERIDO
-- (sai da visão do cockpit). Operação corrige + lança oc=49 → card volta pra
-- relacionamento com 6 propostas via REGRAS_AUTO_ACAO[49].
--
-- Reusa: auto_aprovar_e_executar (já marca aprovacao_modo='autonoma' via
-- migration 022).
-- ============================================================================

DROP FUNCTION IF EXISTS public.auto_lancar_oc56_sem_evidencia(uuid);

CREATE OR REPLACE FUNCTION public.auto_lancar_oc56_sem_evidencia(p_card_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_card record;
  v_todo_id uuid;
  v_action_id uuid;
  v_chave_cte text;
  v_cnpj_remetente text;
  v_descricao text;
BEGIN
  SELECT id, nf, agent_state, cod_ultima_ocorrencia, sem_chave_cte, state
  INTO v_card
  FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id;
  END IF;

  -- Sem chave_cte não dá pra lançar oc no SSW. Se cair aqui, registra evento
  -- mas não tenta — Pass F vai resolver chave depois e operadora vê o card
  -- normalmente em AGUARDANDO_AGENTE.
  v_chave_cte := v_card.agent_state->>'chave_cte';
  IF v_chave_cte IS NULL OR v_chave_cte = '' OR v_card.sem_chave_cte = true THEN
    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (p_card_id, 'AcaoAutonomaAdiadaSemChaveCte', 'system', 'auto-oc56',
      jsonb_build_object(
        'oc_origem', v_card.cod_ultima_ocorrencia,
        'motivo', 'auto_lancar_oc56_sem_evidencia chamado mas card sem chave_cte'
      ));
    RETURN jsonb_build_object('ok', false, 'motivo', 'sem_chave_cte');
  END IF;

  v_cnpj_remetente := COALESCE(
    v_card.agent_state->>'cnpj_remetente',
    v_card.agent_state->>'cnpj_pagador'
  );

  v_descricao := 'Falta evidencia operacional da oc '
    || v_card.cod_ultima_ocorrencia
    || ' - reencaminhado para Operacao';

  -- Cria todo de oc=56 (Operação corrigir info)
  v_action_id := gen_random_uuid();
  INSERT INTO public.todos (
    card_id, action_id, descricao, status, proposta_payload
  ) VALUES (
    p_card_id, v_action_id,
    'Lançar oc 56 — falta evidência da oc ' || v_card.cod_ultima_ocorrencia || ' (autônomo)',
    'pendente',
    jsonb_build_object(
      'tool', 'lancar_ocorrencia',
      'args', jsonb_build_object(
        'codigo_ssw', 56,
        'nf', v_card.nf,
        'chave_cte', v_chave_cte,
        'cnpj_remetente', v_cnpj_remetente,
        'descricao', v_descricao
      ),
      'rationale', 'Detecção autônoma 2026-05-06: oc=' || v_card.cod_ultima_ocorrencia
        || ' sem foto no SSW. Encaminhado pra Operação corrigir.',
      'meta', jsonb_build_object(
        'origem', 'auto_lancar_oc56_sem_evidencia',
        'oc_origem', v_card.cod_ultima_ocorrencia
      )
    )
  ) RETURNING id INTO v_todo_id;

  -- Card_event antes de auto-aprovar (auditoria visual)
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'AcaoAutonomaSemEvidencia', 'system', 'auto-oc56',
    jsonb_build_object(
      'oc_origem', v_card.cod_ultima_ocorrencia,
      'oc_lancada', 56,
      'todo_id', v_todo_id,
      'motivo', 'SSW sem foto anexada na ocorrência atual'
    ));

  -- Auto-aprova: marca aprovacao_modo='autonoma', enfileira no executor
  PERFORM public.auto_aprovar_e_executar(v_todo_id, 'evidencia_ausente_oc56');

  RETURN jsonb_build_object(
    'ok', true,
    'todo_id', v_todo_id,
    'card_id', p_card_id,
    'oc_lancada', 56
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auto_lancar_oc56_sem_evidencia(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_lancar_oc56_sem_evidencia(uuid) TO service_role;

COMMENT ON FUNCTION public.auto_lancar_oc56_sem_evidencia IS
  'Lança oc=56 autonomamente quando hook detecta que oc=10/11/35 está sem foto SSW. '
  'Reusa auto_aprovar_e_executar (que marca aprovacao_modo=autonoma e enfileira pgmq). '
  'Bloqueia se card sem_chave_cte=true (registra evento e retorna false).';
