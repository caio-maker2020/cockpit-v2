-- =============================================================================
-- 2026-06-16 — soft-delete dos 694 cards do CARLOS (offboarding total)
-- =============================================================================
-- Contexto: CARLOS desativado total no reorg 2026-06-15. Mig 207 limpou
-- contatos_cliente + tracking_credentials. Mig 208 cuida dos cards.
--
-- Caio 2026-06-16 escolheu SOFT-DELETE (state='CANCELADO' + assigned=NULL)
-- em vez de DELETE físico — DELETE apagaria 69.779 card_events + 4.114 todos
-- via CASCADE, perdendo trilha histórica irreversível.
--
-- Estratégia:
--   - state='CANCELADO' (já existente na CHECK constraint)
--   - assigned_operator_id=NULL (cards ficam "sem dono")
--   - lock_aguardando_validacao=false (libera locks)
--   - acao_executada_em=NULL (zera estado de execução)
--   - card_event 'OffboardedOperadorDesativado' por card (rastreabilidade)
--   - todos pendentes (proposto) → cancelado
--
-- Reversível: se errar, basta UPDATE state de volta. Histórico intacto.
--
-- Pós-mig: cards somem do Kanban (state CANCELADO filtrado). Quando o cliente
-- voltar pra Bastão e algum operador ativo já tiver reivindicado (recadastrado
-- via cadastrar_cliente_completo), o próximo sync-bastao cria CARD NOVO pro
-- operador certo. Esses 694 cards antigos ficam como histórico arquivado.
-- =============================================================================

DO $$
DECLARE
  v_carlos_id uuid;
  v_card record;
  v_event_id uuid;
  v_count_cards int := 0;
  v_count_todos_canc int := 0;
  v_count_locks_lib int := 0;
  v_canc int;
BEGIN
  SELECT id INTO v_carlos_id FROM public.operadores WHERE nome = 'CARLOS' LIMIT 1;
  IF v_carlos_id IS NULL THEN
    RAISE NOTICE 'CARLOS não encontrado — nada a fazer';
    RETURN;
  END IF;

  FOR v_card IN
    SELECT id, nf, state, lock_aguardando_validacao, cod_ultima_ocorrencia
    FROM public.cards
    WHERE assigned_operator_id = v_carlos_id
  LOOP
    -- 1. Card event ANTES do UPDATE pra preservar contexto (state anterior)
    INSERT INTO public.card_events (
      card_id, event_type, actor_type, actor_id, payload
    ) VALUES (
      v_card.id,
      'OffboardedOperadorDesativado',
      'system',
      'mig_208_offboarding_carlos',
      jsonb_build_object(
        'motivo', 'CARLOS desativado no reorg 2026-06-15 — clientes redistribuídos pra outros operadores',
        'state_anterior', v_card.state,
        'operador_anterior', 'CARLOS',
        'tinha_lock', v_card.lock_aguardando_validacao,
        'codigo_oc', v_card.cod_ultima_ocorrencia,
        'fonte', 'mig 208 / soft-delete preserva histórico (69k events + 4k todos)',
        'observacao', 'Card pode reaparecer no operador certo via sync-bastao quando cliente for recadastrado'
      )
    ) RETURNING id INTO v_event_id;

    -- 2. UPDATE card pra CANCELADO + sem dono + sem lock
    UPDATE public.cards
    SET state = 'CANCELADO',
        assigned_operator_id = NULL,
        lock_aguardando_validacao = false,
        acao_executada_em = NULL,
        last_event_id = v_event_id,
        updated_at = now()
    WHERE id = v_card.id;

    IF v_card.lock_aguardando_validacao THEN
      v_count_locks_lib := v_count_locks_lib + 1;
    END IF;

    -- 3. Cancelar todos pendentes
    UPDATE public.todos
    SET status = 'cancelado',
        rejection_reason = COALESCE(rejection_reason || ' | ', '') ||
          'auto-cancelado mig 208: CARLOS desativado'
    WHERE card_id = v_card.id
      AND status = 'proposto';
    GET DIAGNOSTICS v_canc = ROW_COUNT;
    v_count_todos_canc := v_count_todos_canc + v_canc;

    v_count_cards := v_count_cards + 1;
  END LOOP;

  RAISE NOTICE 'mig 208 offboarding CARLOS: % cards CANCELADOS, % todos cancelados, % locks liberados',
    v_count_cards, v_count_todos_canc, v_count_locks_lib;
END $$;

-- Sanity
DO $$
DECLARE
  v_carlos_id uuid;
  v_residual int;
BEGIN
  SELECT id INTO v_carlos_id FROM public.operadores WHERE nome = 'CARLOS' LIMIT 1;
  IF v_carlos_id IS NULL THEN RETURN; END IF;

  SELECT COUNT(*) INTO v_residual
    FROM public.cards WHERE assigned_operator_id = v_carlos_id;

  IF v_residual > 0 THEN
    RAISE EXCEPTION 'mig 208 falhou: % cards ainda apontam pro CARLOS', v_residual;
  END IF;
END $$;
