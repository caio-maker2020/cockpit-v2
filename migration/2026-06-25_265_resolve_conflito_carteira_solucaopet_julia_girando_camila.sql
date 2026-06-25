-- =============================================================================
-- 2026-06-25_265 — Resolve conflito de carteira (cliente em 2 planilhas)
-- =============================================================================
-- 2 CNPJs apareciam na planilha NOVA (Julia/Camila) E na carteira atual do
-- ISA E KAROL. Caio decidiu (planilha=verdade, 2026-06-24/25):
--   - 27748346000129 SOLUCAO PET DISTRIBUIDORA → JULIA  (tira do Isa & Karol)
--   - 81676009001190 GIRANDO COM. / ROLEMAR    → CAMILA (tira do Isa & Karol)
--
-- Ações:
--   1. Remove os 2 CNPJs da carteira do ISA E KAROL (array_remove).
--   2. Reatribui TODOS os cards ativos desses CNPJs pro dono decidido, com
--      segmento_codigo do dono (sai da rede seg-043 do Isa & Karol):
--        SOLUCAO PET → JULIA  + segmento_codigo='005' (saúde animal / pet)
--        GIRANDO     → CAMILA + segmento_codigo='001' (auto peças)
--   3. Atualiza catálogo clientes (segmento).
-- Bastão classifica ambos como seg 043, mas a planilha do Caio manda — por isso
-- forço o segmento do dono pra não revazar pro Isa & Karol no próximo sync.
-- Event sourcing por card. Idempotente. skill: supabase-postgres-best-practices.
-- =============================================================================
BEGIN;

-- 1. Remove da carteira do Isa & Karol
UPDATE public.operadores
SET carteira = array_remove(array_remove(carteira, '27748346000129'), '81676009001190')
WHERE nome='ISA E KAROL';

-- 2. Reatribuição dos cards
DO $$
DECLARE v_julia uuid; v_camila uuid; v_a int; v_b int;
BEGIN
  SELECT id INTO v_julia  FROM public.operadores WHERE nome='JULIA';
  SELECT id INTO v_camila FROM public.operadores WHERE nome='CAMILA';

  -- SOLUCAO PET → JULIA (seg 005)
  WITH afet AS (
    SELECT id, responsavel_relacionamento resp_old, assigned_operator_id aid_old
    FROM public.cards
    WHERE state NOT IN ('RESOLVIDO','CANCELADO')
      AND lpad(regexp_replace(agent_state->>'cnpj_pagador','\D','','g'),14,'0')='27748346000129'
      AND (assigned_operator_id IS DISTINCT FROM v_julia OR segmento_codigo IS DISTINCT FROM '005')
  ), upd AS (
    UPDATE public.cards c SET assigned_operator_id=v_julia, responsavel_relacionamento='JULIA', segmento_codigo='005'
    FROM afet a WHERE c.id=a.id RETURNING c.id, a.resp_old, a.aid_old
  )
  INSERT INTO public.card_events (card_id,event_type,actor_type,actor_id,payload)
  SELECT id,'OperadorReatribuido','system','fix_mig_265',
    jsonb_build_object('responsavel_anterior',resp_old,'assigned_anterior',aid_old,'responsavel_novo','JULIA',
      'cnpj_pagador','27748346000129','motivo','Conflito de carteira resolvido pelo Caio: SOLUCAO PET é da Julia (planilha=verdade)')
  FROM upd; GET DIAGNOSTICS v_a = ROW_COUNT;

  -- GIRANDO → CAMILA (seg 001)
  WITH afet AS (
    SELECT id, responsavel_relacionamento resp_old, assigned_operator_id aid_old
    FROM public.cards
    WHERE state NOT IN ('RESOLVIDO','CANCELADO')
      AND lpad(regexp_replace(agent_state->>'cnpj_pagador','\D','','g'),14,'0')='81676009001190'
      AND (assigned_operator_id IS DISTINCT FROM v_camila OR segmento_codigo IS DISTINCT FROM '001')
  ), upd AS (
    UPDATE public.cards c SET assigned_operator_id=v_camila, responsavel_relacionamento='CAMILA', segmento_codigo='001'
    FROM afet a WHERE c.id=a.id RETURNING c.id, a.resp_old, a.aid_old
  )
  INSERT INTO public.card_events (card_id,event_type,actor_type,actor_id,payload)
  SELECT id,'OperadorReatribuido','system','fix_mig_265',
    jsonb_build_object('responsavel_anterior',resp_old,'assigned_anterior',aid_old,'responsavel_novo','CAMILA',
      'cnpj_pagador','81676009001190','motivo','Conflito de carteira resolvido pelo Caio: GIRANDO/ROLEMAR é da Camila (planilha=verdade)')
  FROM upd; GET DIAGNOSTICS v_b = ROW_COUNT;

  RAISE NOTICE 'mig 265: SOLUCAO PET→JULIA % cards, GIRANDO→CAMILA % cards', v_a, v_b;
END $$;

-- 3. Catálogo clientes
UPDATE public.clientes SET segmento_codigo='005', segmento_nome='SAUDE ANIMAL' WHERE cnpj_cpf='27748346000129';
UPDATE public.clientes SET segmento_codigo='001', segmento_nome='AUTO PECAS'   WHERE cnpj_cpf='81676009001190';

COMMIT;
