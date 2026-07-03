-- =============================================================================
-- 2026-07-02_288 — CENTERVIDA (CNPJ 10369301000140) move LARISSA → ISA E KAROL
-- =============================================================================
-- Diretriz Caio 2026-07-02: "o CNPJ 10369301000140 está vinculado à LARISSA,
-- precisa ir para a ISA/KAROL". Reatribuição de dono (dado, não bug).
--
-- Vínculo CNPJ→operadora vive em 4 camadas (resolver: carteira = prioridade
-- absoluta, "1 CNPJ = 1 operador"):
--   1. operadores.carteira (text[] allowlist — decide roteamento de cards novos)
--   2. contatos_cliente.operador_responsavel_id  (RLS: e-mail do cliente)
--   3. tracking_credentials.operador_responsavel_id (RLS: rastreio SSW)
--   4. cards.assigned_operator_id + responsavel_relacionamento (+ card_events)
--
-- clientes.segmento_codigo FICA 010 (CENTERVIDA é hospitalar; posse é via
-- carteira, não via rótulo de segmento). Cards mantêm segmento_codigo vazio →
-- sem vazamento pra visão da LARISSA {007,010,018}.
--
-- Cards terminais (RESOLVIDO/CANCELADO) NÃO movem (histórico) — espelha mig 264.
-- Idempotente. Event sourcing preservado. skill: supabase-postgres-best-practices.
-- =============================================================================
BEGIN;

DO $$
DECLARE
  v_cnpj      text := '10369301000140';
  v_larissa   uuid;
  v_isakarol  uuid;
  v_cont int; v_track int; v_cards int;
BEGIN
  SELECT id INTO v_larissa  FROM public.operadores WHERE nome = 'LARISSA';
  SELECT id INTO v_isakarol FROM public.operadores WHERE nome = 'ISA E KAROL';
  IF v_larissa IS NULL OR v_isakarol IS NULL THEN
    RAISE EXCEPTION 'operador nao encontrado (larissa=% isakarol=%)', v_larissa, v_isakarol;
  END IF;

  -- 1. carteira: remove da LARISSA, adiciona na ISA E KAROL (dedup)
  UPDATE public.operadores
     SET carteira = array_remove(carteira, v_cnpj)
   WHERE id = v_larissa;

  UPDATE public.operadores
     SET carteira = (SELECT array_agg(DISTINCT x)
                     FROM unnest(array_append(carteira, v_cnpj)) x)
   WHERE id = v_isakarol;

  -- 2. contatos_cliente
  UPDATE public.contatos_cliente
     SET operador_responsavel_id = v_isakarol, updated_at = now()
   WHERE regexp_replace(documento_cliente, '\D', '', 'g') = v_cnpj
     AND operador_responsavel_id = v_larissa;
  GET DIAGNOSTICS v_cont = ROW_COUNT;

  -- 3. tracking_credentials
  UPDATE public.tracking_credentials
     SET operador_responsavel_id = v_isakarol, updated_at = now()
   WHERE regexp_replace(documento, '\D', '', 'g') = v_cnpj
     AND operador_responsavel_id = v_larissa;
  GET DIAGNOSTICS v_track = ROW_COUNT;

  -- 4. cards nao-terminais + card_events (event sourcing)
  WITH upd AS (
    UPDATE public.cards c
       SET assigned_operator_id       = v_isakarol,
           responsavel_relacionamento = 'ISA E KAROL'
     WHERE lpad(regexp_replace(c.agent_state->>'cnpj_pagador', '\D', '', 'g'), 14, '0') = v_cnpj
       AND c.assigned_operator_id = v_larissa
       AND c.state NOT IN ('RESOLVIDO', 'CANCELADO')
    RETURNING c.id
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id, 'OperadorReatribuido', 'system', 'fix_mig_288',
         jsonb_build_object(
           'responsavel_anterior', 'LARISSA',
           'responsavel_novo',     'ISA E KAROL',
           'cnpj_pagador',         v_cnpj,
           'motivo',               'Diretriz Caio 2026-07-02: CNPJ CENTERVIDA move de LARISSA para ISA E KAROL')
  FROM upd;
  GET DIAGNOSTICS v_cards = ROW_COUNT;

  RAISE NOTICE 'mig 288 CENTERVIDA %: contatos=%, tracking=%, cards=%',
    v_cnpj, v_cont, v_track, v_cards;
END $$;

COMMIT;
