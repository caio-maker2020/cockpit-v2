-- ============================================================================
-- 2026-08-12_332 — AJUSTE DA CARTEIRA DA INGRID pela planilha final (Caio 12/08).
--
-- A planilha "Emails clientes Ingrid" (08:50) trouxe 2 CNPJs que não estavam
-- na carteira dela. Decisões do Caio (verbatim):
--   • 46.044.053/0025-82 "é de fato da ingrid. pode fazer a alteração da
--     isabelly para ingrid" → MOVER de ISABELY→INGRID (tem 1 card vivo: NF 540789).
--   • 53.296.273/0001-91 "sim pode vincular no da ingrid" → ADICIONAR à carteira
--     da Ingrid (Black Decker; cliente novo, seg 014).
--
-- Aplicar SÓ NO MERGE FINAL (junto com a ativação). Idempotente.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1) MOVER 46044053002582: tira da ISABELY, põe na INGRID -----------------------
UPDATE operadores
SET carteira = array_remove(
  ARRAY(SELECT x FROM unnest(carteira) x
        WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') <> '46044053002582'),
  NULL)
WHERE nome = 'ISABELY';

UPDATE operadores
SET carteira = (
  SELECT array_agg(DISTINCT c)
  FROM unnest(coalesce(carteira,'{}'::text[]) || ARRAY['46044053002582']) c)
WHERE nome = 'INGRID'
  AND NOT EXISTS (
    SELECT 1 FROM unnest(carteira) x
    WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') = '46044053002582');

-- 2) ADICIONAR 53296273000191 à INGRID + cliente + oc13 + config Würth-não ----
UPDATE operadores
SET carteira = (
  SELECT array_agg(DISTINCT c)
  FROM unnest(coalesce(carteira,'{}'::text[]) || ARRAY['53296273000191']) c)
WHERE nome = 'INGRID'
  AND NOT EXISTS (
    SELECT 1 FROM unnest(carteira) x
    WHERE lpad(regexp_replace(x,'\D','','g'),14,'0') = '53296273000191');

INSERT INTO clientes (cnpj_cpf, nome, segmento_codigo, segmento_nome, ativo)
VALUES ('53296273000191', 'BLACK DECKER DO BRASIL LTDA', '014', 'FERRAMENTAS E CONSTRUCAO', true)
ON CONFLICT (cnpj_cpf) DO UPDATE SET ativo = true;

-- SBD também na exceção oc 13 (espelho da matriz 003298)
INSERT INTO cliente_config_oc13 (cnpj_pagador, nome_cliente, ativo, observacao)
VALUES ('53296273000191', 'BLACK DECKER DO BRASIL LTDA', true,
        'Exceção oc=13 (Ingrid, filial 0001-91) — planilha final 2026-08-12')
ON CONFLICT (cnpj_pagador) DO UPDATE SET ativo = true;

-- SBD parcial: mesma config da matriz (romaneio por Nº Remessa, só parcial)
INSERT INTO cliente_config
  (cnpj_pagador, nome_cliente, usa_romaneio_interno, template_email_extravio_total,
   romaneio_escopo, romaneio_busca_chave, intranet_wurth, notes, ativo)
VALUES
  ('53296273000191', 'BLACK DECKER DO BRASIL LTDA', true, 'EXTRAVIO_TOTAL_NOTIFICACAO',
   'so_parcial', 'numero_remessa_danfe', false,
   'SBD filial 0001-91 (planilha final 2026-08-12) — mesma regra da matriz 003298.', true)
ON CONFLICT (cnpj_pagador) DO UPDATE SET
  usa_romaneio_interno = EXCLUDED.usa_romaneio_interno,
  romaneio_escopo = EXCLUDED.romaneio_escopo,
  romaneio_busca_chave = EXCLUDED.romaneio_busca_chave;

-- 3) contatos do 53296273000191 = espelho dos da matriz SBD (mesma equipe) -----
DO $c$
DECLARE v_ingrid uuid;
BEGIN
  SELECT id INTO v_ingrid FROM operadores WHERE nome='INGRID';
  DELETE FROM contatos_cliente WHERE documento_cliente='53296273000191'
    AND tipo_uso='logistico' AND operador_responsavel_id=v_ingrid;
  INSERT INTO contatos_cliente (documento_cliente, tipo, identificador, ordem, tipo_uso, nome_pessoa, ativo, operador_responsavel_id)
  SELECT '53296273000191', tipo, identificador, ordem, tipo_uso, nome_pessoa, ativo, operador_responsavel_id
  FROM contatos_cliente WHERE documento_cliente='53296273003298'
    AND tipo_uso='logistico' AND operador_responsavel_id=v_ingrid;
END $c$;

-- 4) reatribuição do card vivo do 002582 (NF 540789) ISABELY→INGRID ------------
-- Só se a Ingrid já estiver ativa (senão a mig 330 de ativação faz o sweep).
WITH upd AS (
  UPDATE cards c SET
    assigned_operator_id = (SELECT id FROM operadores WHERE nome='INGRID'),
    responsavel_relacionamento = 'INGRID'
  WHERE c.state NOT IN ('RESOLVIDO','CANCELADO','TRANSFERIDO')
    AND lpad(regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g'),14,'0')='46044053002582'
    AND EXISTS (SELECT 1 FROM operadores o WHERE o.nome='INGRID' AND o.cockpit_ativo)
    AND c.assigned_operator_id IS DISTINCT FROM (SELECT id FROM operadores WHERE nome='INGRID')
  RETURNING c.id
)
INSERT INTO card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT id, 'OperadorReatribuido', 'system', 'mig_332',
       jsonb_build_object('de','ISABELY','para','INGRID','motivo','planilha final 2026-08-12, CNPJ 46044053002582')
FROM upd;

-- Guardas: INV-036a (nenhum CNPJ da Ingrid em outra carteira ATIVA)
DO $g$
DECLARE v_dup text;
BEGIN
  SELECT string_agg(DISTINCT o2.nome, ', ') INTO v_dup
  FROM operadores o1, operadores o2, unnest(o1.carteira) c
  WHERE o1.nome='INGRID' AND o2.nome<>'INGRID' AND o2.ativo AND o2.cockpit_ativo
    AND lpad(regexp_replace(c,'\D','','g'),14,'0') = ANY(
      SELECT lpad(regexp_replace(x,'\D','','g'),14,'0') FROM unnest(o2.carteira) x);
  IF v_dup IS NOT NULL THEN RAISE EXCEPTION 'GUARDA INV-036a: CNPJ da Ingrid em carteira ativa de %', v_dup; END IF;
END $g$;

COMMIT;
