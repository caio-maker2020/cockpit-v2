-- =============================================================================
-- 2026-06-16 — transferir cards oc=52 ativos pra TRANSFERIDO (responsabilidade
-- de Operação, não Relacionamento)
-- =============================================================================
-- Contexto: drift entre dicionário (verdade absoluta, mig 204) e Set hardcoded
-- em `_shared/bastao-rules.ts`. Hardcoded incluía oc=52 como Relacionamento;
-- dicionário diz Operação. Refator do código pra ler dinamicamente do
-- dicionário já feito (mesmo PR). Esta migration cuida do backfill dos cards
-- já atribuídos errado a operadores de Relacionamento.
--
-- 17 cards afetados:
--   - 15 AGUARDANDO_AGENTE (sem ação iniciada)
--   - 1  AGUARDANDO_CLIENTE (cliente já notificado por email)
--   - 1  AGUARDANDO_VALIDACAO_HUMANA (lock=true; operador prestes a aprovar)
--
-- Caio decidiu (2026-06-16) mover TODOS pra TRANSFERIDO mesmo os 2 em fluxo
-- ativo — Operação assume daqui pra frente. Email já enviado ao cliente fica
-- como histórico (não desfaz).
--
-- Operações por card:
--   1. cards: state='TRANSFERIDO', assigned_operator_id=NULL,
--             lock_aguardando_validacao=false, acao_executada_em=NULL
--   2. todos: cancelar todos pendentes (status='proposto'→'cancelado')
--   3. card_events: insere 'TransferidoOcOperacao' (audit trail)
--
-- Idempotente: WHERE filtra só cards com state ainda ativo. Reexecução = no-op.
-- =============================================================================

DO $$
DECLARE
  v_card record;
  v_event_id uuid;
  v_count_cards int := 0;
  v_count_todos int := 0;
BEGIN
  FOR v_card IN
    SELECT id, nf, state, assigned_operator_id, lock_aguardando_validacao
    FROM public.cards
    WHERE cod_ultima_ocorrencia = 52
      AND state NOT IN ('TRANSFERIDO', 'RESOLVIDO', 'CANCELADO')
  LOOP
    -- 1. Card event ANTES do UPDATE pra preservar contexto (state anterior)
    INSERT INTO public.card_events (
      card_id, event_type, actor_type, actor_id, payload
    ) VALUES (
      v_card.id,
      'TransferidoOcOperacao',
      'system',
      'mig_206_backfill',
      jsonb_build_object(
        'motivo', 'oc=52 (Tratativa pra retirada de carga) é responsabilidade de Operação, não Relacionamento',
        'state_anterior', v_card.state,
        'assigned_operator_anterior', v_card.assigned_operator_id,
        'tinha_lock', v_card.lock_aguardando_validacao,
        'fonte', 'mig_206 / drift dicionario-vs-hardcoded resolvido 2026-06-16',
        'codigo_oc', 52,
        'setor_destino', 'Operação'
      )
    ) RETURNING id INTO v_event_id;

    -- 2. UPDATE card pra TRANSFERIDO, libera lock, zera ação
    UPDATE public.cards
    SET state = 'TRANSFERIDO',
        assigned_operator_id = NULL,
        lock_aguardando_validacao = false,
        acao_executada_em = NULL,
        last_event_id = v_event_id,
        updated_at = now()
    WHERE id = v_card.id;

    -- 3. Cancelar todos pendentes desse card
    DECLARE
      v_canc int;
    BEGIN
      UPDATE public.todos
      SET status = 'cancelado',
          rejection_reason = COALESCE(rejection_reason, '') ||
            ' [auto-cancelado mig 206: oc=52 transferida pra Operação]'
      WHERE card_id = v_card.id
        AND status = 'proposto';
      GET DIAGNOSTICS v_canc = ROW_COUNT;
      v_count_todos := v_count_todos + v_canc;
    END;

    v_count_cards := v_count_cards + 1;

    RAISE NOTICE 'Card transferido: id=% nf=% state_anterior=% had_lock=%',
      v_card.id, v_card.nf, v_card.state, v_card.lock_aguardando_validacao;
  END LOOP;

  RAISE NOTICE 'mig 206 backfill: % cards transferidos, % todos cancelados', v_count_cards, v_count_todos;
END $$;

-- Sanity check: deve retornar 0 cards oc=52 ativos pós-backfill
DO $$
DECLARE
  v_ativos int;
BEGIN
  SELECT COUNT(*) INTO v_ativos
  FROM public.cards
  WHERE cod_ultima_ocorrencia = 52
    AND state NOT IN ('TRANSFERIDO', 'RESOLVIDO', 'CANCELADO');

  IF v_ativos > 0 THEN
    RAISE EXCEPTION 'mig 206 falhou: ainda há % cards oc=52 ativos pós-backfill', v_ativos;
  END IF;
END $$;
