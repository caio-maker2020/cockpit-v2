-- ============================================================================
-- 2026-08-10_323 — ATIVAÇÃO da MARIA EDUARDA (plano aprovado 10/08).
--
-- Pré-requisitos (guardas abortam se faltarem): auth user criado via Admin API
-- (uuid abaixo), seed de contatos da mig 322 presente, carteira íntegra.
-- Efeito: MARIA sai de dormente → cockpit_ativo=true; o resolver Path 1a passa
-- a casar a carteira dela e o sync-bastao inclui os 24 CNPJs na allowlist no
-- próximo ciclo. Retroativo de cards: esperado 0 (verificado no preflight) —
-- bloco idempotente fica por segurança, com card_events.
-- ============================================================================

BEGIN;

DO $g$
DECLARE v_maria uuid; v_cart int; v_esp int; v_dupla text;
BEGIN
  SELECT id INTO v_maria FROM operadores WHERE nome = 'MARIA';
  IF v_maria IS NULL THEN RAISE EXCEPTION 'G1: MARIA não existe'; END IF;

  -- G2: auth user existe e é o esperado
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = 'f70c7832-f372-4c34-aea9-885571f04794'
                   AND lower(email) = 'maria.ferreira@salexpress.com.br') THEN
    RAISE EXCEPTION 'G2: auth user da Maria não encontrado';
  END IF;

  -- G3: carteira 24 + segmentos {040,042} (âncora INV-048 pós-planilha)
  SELECT array_length(carteira, 1) INTO v_cart FROM operadores WHERE id = v_maria;
  IF v_cart IS DISTINCT FROM 24 THEN RAISE EXCEPTION 'G3: carteira=% (esperado 24)', v_cart; END IF;
  IF NOT (SELECT segmentos @> '{040,042}'::text[] FROM operadores WHERE id = v_maria) THEN
    RAISE EXCEPTION 'G3b: segmentos divergentes';
  END IF;

  -- G4: seed da mig 322 presente
  SELECT count(*) INTO v_esp FROM contatos_cliente
   WHERE operador_responsavel_id = v_maria AND cnpj_remetente IS NOT NULL;
  IF v_esp < 500 THEN RAISE EXCEPTION 'G4: seed ausente/incompleto (%)', v_esp; END IF;

  -- G5: nenhum CNPJ dela em carteira de outro operador ATIVO (INV-036a)
  SELECT string_agg(DISTINCT o2.nome, ', ') INTO v_dupla
  FROM operadores o1, operadores o2, unnest(o1.carteira) c
  WHERE o1.id = v_maria AND o2.id <> v_maria AND o2.ativo
    AND lpad(regexp_replace(c, '\D', '', 'g'), 14, '0') = ANY(
      SELECT lpad(regexp_replace(x, '\D', '', 'g'), 14, '0') FROM unnest(o2.carteira) x);
  IF v_dupla IS NOT NULL THEN RAISE EXCEPTION 'G5: CNPJ em dupla carteira com %', v_dupla; END IF;
END $g$;

-- Camada 0: acorda a operadora (login + identidade de e-mail)
UPDATE operadores
SET user_id = 'f70c7832-f372-4c34-aea9-885571f04794',
    email = 'maria.ferreira@salexpress.com.br',
    email_relacionamento = 'maria.ferreira@salexpress.com.br',
    nome_email_outbound = 'Maria Eduarda',
    cockpit_ativo = true,
    ativo = true
WHERE nome = 'MARIA';

-- Auditoria de credencial (mesmo trilho do admin-operadores; colunas reais:
-- operador_id, tipo, ator_email, detalhe)
INSERT INTO operador_credencial_eventos (operador_id, tipo, ator_email, detalhe)
SELECT id, 'admin_criou_login', 'caio@salexpress.com.br',
       jsonb_build_object('origem', 'onboarding_mig_323',
                          'email', 'maria.ferreira@salexpress.com.br',
                          'via', 'admin_api')
FROM operadores WHERE nome = 'MARIA';

-- Camada 4b: reatribuição de cards ativos da carteira (esperado 0 — segurança)
WITH alvo AS (
  SELECT c.id
  FROM cards c, operadores o
  WHERE o.nome = 'MARIA'
    AND c.state NOT IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO')
    AND lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador', ''), '\D', '', 'g'), 14, '0')
        = ANY(SELECT lpad(regexp_replace(x, '\D', '', 'g'), 14, '0') FROM unnest(o.carteira) x)
    AND c.assigned_operator_id IS DISTINCT FROM o.id
), upd AS (
  UPDATE cards SET
    assigned_operator_id = (SELECT id FROM operadores WHERE nome = 'MARIA'),
    responsavel_relacionamento = 'MARIA',
    segmento_codigo = NULL
  WHERE id IN (SELECT id FROM alvo)
  RETURNING id
)
INSERT INTO card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT id, 'OperadorReatribuido', 'system', 'onboarding_mig_323',
       jsonb_build_object('para', 'MARIA', 'motivo', 'ativacao_onboarding')
FROM upd;

-- Pós-check: ativa e íntegra
DO $p$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM operadores WHERE nome = 'MARIA' AND ativo AND cockpit_ativo
                   AND user_id IS NOT NULL AND email_relacionamento IS NOT NULL) THEN
    RAISE EXCEPTION 'PÓS: ativação incompleta';
  END IF;
END $p$;

COMMIT;
