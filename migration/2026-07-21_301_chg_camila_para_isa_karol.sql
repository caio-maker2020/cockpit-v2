-- =============================================================================
-- 2026-07-21_301 — Resolve conflito de carteira: CHG AUTOMOTIVA → ISA E KAROL
-- =============================================================================
-- Achado durante o onboarding da Karoline (mig 300): o CNPJ 55176358000323
-- (CHG AUTOMOTIVA) estava em DUAS carteiras ativas — CAMILA + ISA E KAROL —
-- conflito PRÉ-EXISTENTE (não causado pela mig 300; INV-036(a) acusou).
-- Diretriz Caio 2026-07-21: "CHG é cliente da ISA E KAROL". Tira da CAMILA.
--
-- Estado no momento (verificado read-only): 2 cards ativos (1 AGUARDANDO_CLIENTE
-- + 1 AVH), 2 contatos e 1 tracking apontando pra CAMILA. Move as 4 camadas.
-- Zera segmento_codigo dos cards (CHG é auto-peças seg 001 = segmento da CAMILA;
-- sem zerar, CAMILA continuaria vendo via branch RLS (c)).
--
-- Cards terminais (RESOLVIDO/CANCELADO/TRANSFERIDO) NÃO movem (histórico).
-- Idempotente. Event sourcing. skill: supabase-postgres-best-practices.
-- =============================================================================
BEGIN;

DO $$
DECLARE
  v_cnpj     text := '55176358000323';
  v_camila   uuid;
  v_isakarol uuid;
  v_cont int; v_track int; v_cards int;
BEGIN
  SELECT id INTO v_camila   FROM public.operadores WHERE nome = 'CAMILA';
  SELECT id INTO v_isakarol FROM public.operadores WHERE nome = 'ISA E KAROL';
  IF v_camila IS NULL OR v_isakarol IS NULL THEN
    RAISE EXCEPTION 'STOP: operador nao encontrado (camila=% isakarol=%)', v_camila, v_isakarol;
  END IF;

  -- 1. carteira: remove da CAMILA (ISA E KAROL já tem)
  UPDATE public.operadores SET carteira = array_remove(carteira, v_cnpj) WHERE id = v_camila;
  -- garante que ISA E KAROL tem (dedup)
  UPDATE public.operadores
     SET carteira = (SELECT array_agg(DISTINCT x) FROM unnest(array_append(carteira, v_cnpj)) x)
   WHERE id = v_isakarol;

  -- 2. contatos_cliente
  UPDATE public.contatos_cliente SET operador_responsavel_id = v_isakarol, updated_at = now()
   WHERE regexp_replace(documento_cliente,'\D','','g') = v_cnpj AND operador_responsavel_id = v_camila;
  GET DIAGNOSTICS v_cont = ROW_COUNT;

  -- 3. tracking_credentials
  UPDATE public.tracking_credentials SET operador_responsavel_id = v_isakarol, updated_at = now()
   WHERE regexp_replace(documento,'\D','','g') = v_cnpj AND operador_responsavel_id = v_camila;
  GET DIAGNOSTICS v_track = ROW_COUNT;

  -- 4. cards ATIVOS (exclui TRANSFERIDO) → ISA E KAROL + card_events; zera segmento
  WITH afet AS (
    SELECT c.id, c.responsavel_relacionamento resp_old, c.assigned_operator_id aid_old
    FROM public.cards c
    WHERE lpad(regexp_replace(c.agent_state->>'cnpj_pagador','\D','','g'),14,'0') = v_cnpj
      AND c.state NOT IN ('RESOLVIDO','CANCELADO','TRANSFERIDO')
      AND c.assigned_operator_id IS DISTINCT FROM v_isakarol
  ), upd AS (
    UPDATE public.cards c
       SET assigned_operator_id = v_isakarol, responsavel_relacionamento = 'ISA E KAROL', segmento_codigo = NULL
    FROM afet a WHERE c.id = a.id
    RETURNING c.id, a.resp_old, a.aid_old
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id,'OperadorReatribuido','system','fix_mig_301',
    jsonb_build_object('responsavel_anterior',resp_old,'assigned_anterior',aid_old,
      'responsavel_novo','ISA E KAROL','cnpj_pagador',v_cnpj,
      'motivo','Conflito de carteira resolvido (Caio 2026-07-21): CHG AUTOMOTIVA é da ISA E KAROL, sai da CAMILA')
  FROM upd;
  GET DIAGNOSTICS v_cards = ROW_COUNT;

  RAISE NOTICE 'mig 301 CHG %: contatos=%, tracking=%, cards=%', v_cnpj, v_cont, v_track, v_cards;
END $$;

COMMIT;
