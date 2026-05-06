-- ============================================================================
-- Cockpit v2 — cards_auditoria: snapshot duplicado pra auditoria autônoma
-- Data: 2026-05-06
--
-- Regra Caio 2026-05-06 (refinada): cards de ação autônoma devem ser
-- DUPLICADOS pra tabela `cards_auditoria` (snapshot congelado), enquanto o
-- card primário continua movimentando normalmente nas regras (TRANSFERIDO →
-- AGUARDANDO_AGENTE → etc). Aba AUDITORIA lê de cards_auditoria.
--
-- Por que snapshot e não flag: queremos visualização CONGELADA do estado no
-- momento da decisão autônoma. Se card continua movimentando, eventos novos
-- não devem aparecer na auditoria.
--
-- em_auditoria=true (migration 058) é mantida como flag de "já snapshotado"
-- pra evitar duplicação se RPC for chamada 2x pro mesmo card.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.cards_auditoria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id_original uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  motivo text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),

  -- Campos pra busca rápida sem precisar abrir o snapshot
  nf text,
  ctrc text,
  empresa_cliente text,
  cod_ultima_ocorrencia int,
  state_no_snapshot text,
  cnpj_pagador text,

  -- Snapshots completos congelados no momento da auditoria
  card_snapshot jsonb NOT NULL,
  todos_snapshot jsonb,
  events_snapshot jsonb
);

CREATE INDEX IF NOT EXISTS idx_cards_auditoria_added_at
  ON public.cards_auditoria(added_at DESC);
CREATE INDEX IF NOT EXISTS idx_cards_auditoria_card_orig
  ON public.cards_auditoria(card_id_original);
CREATE INDEX IF NOT EXISTS idx_cards_auditoria_motivo
  ON public.cards_auditoria(motivo);

ALTER TABLE public.cards_auditoria ENABLE ROW LEVEL SECURITY;

-- Leitura: authenticated (Caio + Larissa via cockpit). Escrita: service_role só.
DROP POLICY IF EXISTS cards_auditoria_select_auth ON public.cards_auditoria;
CREATE POLICY cards_auditoria_select_auth
  ON public.cards_auditoria
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON TABLE public.cards_auditoria IS
  'Caio 2026-05-06: snapshot duplicado de cards que dispararam ação autônoma '
  '(oc=56 sem evidência, etc). Read-only no front. Card original (cards.id) '
  'continua movimentando normalmente nas regras.';

-- ============================================================================
-- Atualiza auto_lancar_oc56_sem_evidencia: insere snapshot em cards_auditoria
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
  v_card_snapshot jsonb;
  v_todos_snapshot jsonb;
  v_events_snapshot jsonb;
  v_auditoria_id uuid;
BEGIN
  SELECT * INTO v_card FROM public.cards WHERE id = p_card_id;
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

  -- Snapshot congelado pra cards_auditoria. Card original segue movimentando.
  IF v_card.em_auditoria = false OR v_card.em_auditoria IS NULL THEN
    v_card_snapshot := to_jsonb(v_card);

    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at), '[]'::jsonb)
    INTO v_todos_snapshot
    FROM public.todos t WHERE t.card_id = p_card_id;

    SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.created_at), '[]'::jsonb)
    INTO v_events_snapshot
    FROM public.card_events e WHERE e.card_id = p_card_id;

    INSERT INTO public.cards_auditoria (
      card_id_original, motivo,
      nf, ctrc, empresa_cliente, cod_ultima_ocorrencia, state_no_snapshot,
      cnpj_pagador,
      card_snapshot, todos_snapshot, events_snapshot
    ) VALUES (
      p_card_id, 'oc56_autonoma_sem_evidencia',
      v_card.nf, v_card.ctrc, v_card.empresa_cliente,
      v_card.cod_ultima_ocorrencia, v_card.state,
      v_card.agent_state->>'cnpj_pagador',
      v_card_snapshot, v_todos_snapshot, v_events_snapshot
    ) RETURNING id INTO v_auditoria_id;

    -- Marca pra evitar duplicação se RPC for chamada de novo
    UPDATE public.cards
    SET em_auditoria = true,
        auditoria_motivo = 'oc56_autonoma_sem_evidencia',
        auditoria_added_at = now()
    WHERE id = p_card_id;

    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (p_card_id, 'SnapshotAuditoriaCriado', 'system', 'auto-oc56',
      jsonb_build_object(
        'auditoria_id', v_auditoria_id,
        'motivo', 'oc56_autonoma_sem_evidencia'
      ));
  END IF;

  PERFORM public.auto_aprovar_e_executar(v_todo_id, 'evidencia_ausente_oc56');

  RETURN jsonb_build_object(
    'ok', true,
    'todo_id', v_todo_id,
    'card_id', p_card_id,
    'oc_lancada', 56,
    'auditoria_id', v_auditoria_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auto_lancar_oc56_sem_evidencia(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_lancar_oc56_sem_evidencia(uuid) TO service_role;
