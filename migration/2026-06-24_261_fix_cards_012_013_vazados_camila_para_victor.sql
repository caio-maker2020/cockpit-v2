-- =============================================================================
-- 2026-06-24_261 — Corrige cards seg 012/013 "vazados" pra CAMILA → VICTOR
-- =============================================================================
-- Contexto: a linha-seed "CAMILA" (mig 007, reaproveitada como operadora real no
-- onboarding mig 260) carregava 12 cards ATIVOS de segmento 012/013 atribuídos
-- direto a ela (assigned_operator_id) por histórico antigo (trigger de nome /
-- atribuição manual). Esses segmentos são do VICTOR (segmentos
-- {006,008,011,012,013,020,041}). Ao ativar a Camila no Cockpit, os cards
-- passaram a aparecer pra ela indevidamente.
--
-- Fix: devolve os cards seg 012/013 atribuídos à CAMILA para o VICTOR (dono do
-- segmento), com card_event de auditoria (event sourcing — invariante CLAUDE.md).
-- Idempotente: só toca cards ainda DISTINCT de Victor.
-- skill: supabase-postgres-best-practices
-- =============================================================================
BEGIN;

DO $$
DECLARE
  v_camila uuid; v_victor uuid; v_cnt int;
BEGIN
  SELECT id INTO v_camila FROM public.operadores WHERE nome='CAMILA';
  SELECT id INTO v_victor FROM public.operadores WHERE nome='VICTOR' AND ativo=true;
  IF v_victor IS NULL THEN RAISE EXCEPTION 'VICTOR ativo não encontrado'; END IF;

  WITH afet AS (
    SELECT id, responsavel_relacionamento resp_old, assigned_operator_id aid_old,
           left(agent_state->>'segmento_cliente',3) seg
    FROM public.cards
    WHERE state NOT IN ('RESOLVIDO','CANCELADO')
      AND assigned_operator_id = v_camila
      AND left(agent_state->>'segmento_cliente',3) IN ('012','013')
  ), upd AS (
    UPDATE public.cards c SET
      responsavel_relacionamento='VICTOR', assigned_operator_id=v_victor, segmento_codigo=a.seg
    FROM afet a WHERE c.id=a.id
    RETURNING c.id, a.resp_old, a.aid_old, a.seg
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id,'OperadorReatribuido','system','fix_mig_261',
    jsonb_build_object('responsavel_anterior',resp_old,'assigned_anterior',aid_old,
      'responsavel_novo','VICTOR',
      'motivo','Card seg '||seg||' vazou pra CAMILA (linha-seed) no onboarding mig 260 — devolvido ao dono do segmento',
      'segmento',seg)
  FROM upd;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  RAISE NOTICE 'cards 012/013 CAMILA -> VICTOR: %', v_cnt;
END $$;

COMMIT;
