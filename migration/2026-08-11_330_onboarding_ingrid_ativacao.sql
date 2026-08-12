-- ============================================================================
-- 2026-08-11_330 — ATIVAÇÃO DA INGRID ALVES (aplicar SÓ NO MERGE FINAL,
-- depois da exceção Würth implementada e testada, com aval expresso do Caio).
--
-- Pré-requisitos (guardas abortam se faltarem):
--   1. auth user criado via Admin API com ingrid.alves@salexpress.com.br
--      (senha inicial sal123456 — ela troca no 1º login)
--   2. mig 329 aplicada (exceções SBD + thread-nova)
--   3. seed de contatos da planilha padrão aplicado (fase 4 da branch)
--
-- Efeito: INGRID sai de dormente → cockpit_ativo=true; resolver Path 1a passa
-- a casar os 11 CNPJs da carteira e o sync-bastao os inclui na allowlist.
-- Pós-humano: Ingrid loga → troca senha → conecta o Gmail (Configurações) —
-- o Gmail dela é PRÉ-REQUISITO da exceção Dimensional/Nortel (as respostas
-- b2c chegam na caixa dela).
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $g$
DECLARE v_ingrid uuid; v_user uuid; v_cart int; v_dupla text; v_cfg int;
BEGIN
  SELECT id INTO v_ingrid FROM operadores WHERE nome = 'INGRID';
  IF v_ingrid IS NULL THEN RAISE EXCEPTION 'G1: INGRID não existe'; END IF;

  -- G2: auth user criado (por e-mail — o UUID nasce no Admin API na hora)
  SELECT id INTO v_user FROM auth.users
   WHERE lower(email) = 'ingrid.alves@salexpress.com.br';
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'G2: auth user ingrid.alves@salexpress.com.br não encontrado — criar via Admin API antes';
  END IF;

  -- G3: carteira 11 CNPJs (SBD + Dimensional + Nortel + Würth)
  SELECT array_length(carteira, 1) INTO v_cart FROM operadores WHERE id = v_ingrid;
  IF v_cart IS DISTINCT FROM 11 THEN
    RAISE EXCEPTION 'G3: carteira=% (esperado 11) — planilha mudou? re-conferir', v_cart;
  END IF;

  -- G4: exceções da mig 329 no ar
  SELECT count(*) INTO v_cfg FROM cliente_config
   WHERE cnpj_pagador = '53296273003298' AND romaneio_escopo = 'so_parcial';
  IF v_cfg = 0 THEN RAISE EXCEPTION 'G4: mig 329 (SBD romaneio) não aplicada'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cliente_config_oc13 WHERE cnpj_pagador = '53296273003298' AND ativo) THEN
    RAISE EXCEPTION 'G4b: SBD fora da exceção oc13';
  END IF;

  -- G5: nenhum CNPJ dela em carteira de outro operador ATIVO (INV-036a)
  SELECT string_agg(DISTINCT o2.nome, ', ') INTO v_dupla
  FROM operadores o1, operadores o2, unnest(o1.carteira) c
  WHERE o1.id = v_ingrid AND o2.id <> v_ingrid AND o2.ativo AND o2.cockpit_ativo
    AND lpad(regexp_replace(c, '\D', '', 'g'), 14, '0') = ANY(
      SELECT lpad(regexp_replace(x, '\D', '', 'g'), 14, '0') FROM unnest(o2.carteira) x);
  IF v_dupla IS NOT NULL THEN RAISE EXCEPTION 'G5: CNPJ em dupla carteira com %', v_dupla; END IF;
END $g$;

-- Camada 0: acorda a operadora (login + identidade de e-mail)
UPDATE operadores o
SET user_id = u.id,
    email = 'ingrid.alves@salexpress.com.br',
    email_relacionamento = 'ingrid.alves@salexpress.com.br',
    nome_email_outbound = 'Ingrid Alves',
    cockpit_ativo = true,
    ativo = true
FROM auth.users u
WHERE o.nome = 'INGRID' AND lower(u.email) = 'ingrid.alves@salexpress.com.br';

-- Auditoria de credencial (colunas reais: ator_email + detalhe jsonb — mig 323)
INSERT INTO operador_credencial_eventos (operador_id, tipo, ator_email, detalhe)
SELECT id, 'admin_criou_login', 'caio@salexpress.com.br',
       jsonb_build_object('origem', 'onboarding_mig_330',
                          'email', 'ingrid.alves@salexpress.com.br',
                          'via', 'admin_api')
FROM operadores WHERE nome = 'INGRID';

-- Camada 4b: reatribuição de cards ativos da carteira (esperado 0 — segurança)
WITH alvo AS (
  SELECT c.id
  FROM cards c, operadores o
  WHERE o.nome = 'INGRID'
    AND c.state NOT IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO')
    AND lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador', ''), '\D', '', 'g'), 14, '0')
        = ANY(SELECT lpad(regexp_replace(x, '\D', '', 'g'), 14, '0') FROM unnest(o.carteira) x)
    AND c.assigned_operator_id IS DISTINCT FROM o.id
), upd AS (
  UPDATE cards SET
    assigned_operator_id = (SELECT id FROM operadores WHERE nome = 'INGRID'),
    responsavel_relacionamento = 'INGRID',
    segmento_codigo = NULL
  WHERE id IN (SELECT id FROM alvo)
  RETURNING id
)
INSERT INTO card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT id, 'OperadorReatribuido', 'system', 'onboarding_mig_330',
       jsonb_build_object('para', 'INGRID', 'motivo', 'ativacao_onboarding')
FROM upd;

-- Pós-check: ativa e íntegra
DO $p$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM operadores WHERE nome = 'INGRID' AND ativo AND cockpit_ativo
                   AND user_id IS NOT NULL AND email_relacionamento IS NOT NULL) THEN
    RAISE EXCEPTION 'PÓS: ativação incompleta';
  END IF;
END $p$;

COMMIT;
