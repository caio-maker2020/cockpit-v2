-- ============================================================================
-- Cockpit v2 — cards.em_auditoria + auto_lancar_oc56 popula a flag
-- Data: 2026-05-06
--
-- Regra Caio 2026-05-06: cards que disparam ação autônoma (oc=56 por
-- evidência ausente) precisam ficar visíveis em uma aba AUDITORIA paralela
-- pra Caio + Larissa medirem taxa de erro do processo. Card vai normalmente
-- pra TRANSFERIDO no próximo sync (some do kanban principal), mas a flag
-- em_auditoria=true mantém visibilidade na aba AUDITORIA.
--
-- Frontend deve renderizar cards em_auditoria=true em modo READ-ONLY
-- (botões de ação desabilitados) — auditoria é só leitura.
--
-- Medida temporária. Quando processo provar eficiência, podemos remover ou
-- migrar pra log de métricas.
-- ============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS em_auditoria boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auditoria_motivo text,
  ADD COLUMN IF NOT EXISTS auditoria_added_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_cards_em_auditoria
  ON public.cards(em_auditoria, auditoria_added_at DESC)
  WHERE em_auditoria = true;

COMMENT ON COLUMN public.cards.em_auditoria IS
  'Caio 2026-05-06: card disparou ação autônoma (oc=56 sem evidência, etc) e '
  'deve aparecer na aba AUDITORIA do front em modo read-only. Independente '
  'do state — card pode estar TRANSFERIDO mas continuar visível em auditoria.';

COMMENT ON COLUMN public.cards.auditoria_motivo IS
  'Motivo curto que disparou a auditoria. Ex: "oc56_autonoma_sem_evidencia".';

-- ============================================================================
-- Atualiza auto_lancar_oc56_sem_evidencia (migration 056) pra setar a flag
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

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'AcaoAutonomaSemEvidencia', 'system', 'auto-oc56',
    jsonb_build_object(
      'oc_origem', v_card.cod_ultima_ocorrencia,
      'oc_lancada', 56,
      'todo_id', v_todo_id,
      'motivo', 'SSW sem foto anexada na ocorrência atual'
    ));

  -- Marca card pra aparecer na aba AUDITORIA do front (read-only)
  UPDATE public.cards
  SET em_auditoria = true,
      auditoria_motivo = 'oc56_autonoma_sem_evidencia',
      auditoria_added_at = now()
  WHERE id = p_card_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'AdicionadoEmAuditoria', 'system', 'auto-oc56',
    jsonb_build_object(
      'motivo', 'oc56_autonoma_sem_evidencia',
      'oc_origem', v_card.cod_ultima_ocorrencia,
      'todo_autonoma_id', v_todo_id
    ));

  PERFORM public.auto_aprovar_e_executar(v_todo_id, 'evidencia_ausente_oc56');

  RETURN jsonb_build_object(
    'ok', true,
    'todo_id', v_todo_id,
    'card_id', p_card_id,
    'oc_lancada', 56,
    'em_auditoria', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auto_lancar_oc56_sem_evidencia(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_lancar_oc56_sem_evidencia(uuid) TO service_role;
