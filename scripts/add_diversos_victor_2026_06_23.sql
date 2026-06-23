-- =============================================================================
-- add_diversos_victor_2026_06_23.sql
-- Onboarding ADITIVO de novos clientes/segmentos pro operador VICTOR (Caio 2026-06-23).
-- Fonte: planilha ~/Downloads/DIVERSOS - VICTOR.xlsx (9 clientes).
-- Novos segmentos que entram pro Victor (além de 006/008/011): 012, 013, 020, 041.
--
-- IMPORTANTE: ADITIVO. Victor MANTÉM os 18 clientes/segmentos que já tinha.
-- Diferente do import_victor_isakarol.py (full-replace) — NÃO usar aquele aqui.
--
-- Decisões (confirmadas pelo Caio):
--  - FRIORIO (44039854000238) MIGRA da ISA/Karol pro Victor (regra 1 CNPJ = 1 operador).
--  - TODOS os cards existentes desses CNPJs (ativos + terminais) vão pro Victor.
--  - FRIORIO fica com OS DOIS e-mails no Victor (faturamento@ movido + ingrid.campos@ novo).
--  - segmento_codigo por-cliente fica NULL (planilha não tem coluna de segmento; é
--    metadado de display, não afeta roteamento — que é por carteira/segmentos do operador).
--    FRIORIO tem o 043/CURVA F antigo LIMPO (não é mais bucket Curva F da ISA/Karol).
--  - nome_pessoa dos contatos fica NULL (evita poluição de saudação; a coluna
--    "Responsável" da planilha existe se o Caio quiser backfill depois).
--
-- Idempotente: clientes via ON CONFLICT; contatos via NOT EXISTS; carteira/segmentos
-- via dedup; cards só re-atribuídos se ainda não forem do Victor.
--
-- Execução (dry-run): cat scripts/add_diversos_victor_2026_06_23.sql <(echo 'ROLLBACK;') | psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1
-- Execução (commit):  cat scripts/add_diversos_victor_2026_06_23.sql <(echo 'COMMIT;')   | psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1
-- =============================================================================
BEGIN;

\set victor_id    '8b847d17-b822-4561-87ca-950107e6dd76'
\set isakarol_id  'f67db0fc-90ca-4df0-bdd2-a985b64d3d1e'

-- ---------------------------------------------------------------------------
-- 1) UPSERT dos 9 clientes (FRIORIO já existe -> limpa segmento 043/CURVA F)
-- ---------------------------------------------------------------------------
INSERT INTO clientes (cnpj_cpf, nome, segmento_codigo, segmento_nome, ativo) VALUES
  ('09316105000471','FRIOVIX COMERCIO DE REFRIGERAC',                                 NULL, NULL, true),
  ('30901791000272','TECNOLOGISTICA DISTRIBUIDORA E COMERCIO DE CALCADOS E BOLSAS',   NULL, NULL, true),
  ('08382929002188','RIQUENA NETO AR CONDICIONADO LTDA',                             NULL, NULL, true),
  ('04150555001142','MILLENIUM UTILIDADES DOMESTICAS LTDA',                          NULL, NULL, true),
  ('44039854000238','FRIORIO DISTRIBUIDOR DE PECAS PARA REFRIGERACAO E',             NULL, NULL, true),
  ('06043130000198','COLECAO IND E COM INF ELT LT (C.)',                             NULL, NULL, true),
  ('02274279000127','BINARIO TECNOLOGIA DISTRIBUIDO',                                NULL, NULL, true),
  ('30055933000651','PMI SOUTH AMERICA CONSUMER GOODS LTDA',                         NULL, NULL, true),
  ('04150555000685','MILLENIUM UTILIDADES DOMESTICAS LTDA 3',                        NULL, NULL, true)
ON CONFLICT (cnpj_cpf) DO UPDATE
  SET nome            = EXCLUDED.nome,
      segmento_codigo = EXCLUDED.segmento_codigo,
      segmento_nome   = EXCLUDED.segmento_nome,
      ativo           = true,
      updated_at      = now();

-- ---------------------------------------------------------------------------
-- 2a) FRIORIO: move o contato existente (faturamento@) da ISA/Karol pro Victor
-- ---------------------------------------------------------------------------
UPDATE contatos_cliente
   SET operador_responsavel_id = :'victor_id'::uuid, updated_at = now()
 WHERE documento_cliente = '44039854000238'
   AND lower(identificador) = 'faturamento@friorio.com.br';

-- ---------------------------------------------------------------------------
-- 2b) INSERT dos contatos novos (8 CNPJs + ingrid.campos@ da FRIORIO).
--     NOT EXISTS por (documento_cliente, lower(identificador)) = idempotente.
-- ---------------------------------------------------------------------------
INSERT INTO contatos_cliente
  (documento_cliente, tipo, identificador, nome_pessoa, operador_responsavel_id, tipo_uso, ordem, ativo)
SELECT v.cnpj, 'email', v.email, NULL, :'victor_id'::uuid, 'geral', 1, true
FROM (VALUES
  ('09316105000471','sac.atendimento.entrega@friopecas.com.br'),
  ('30901791000272','gustavooliveira@constance.com.br'),
  ('08382929002188','emily.silva@centralar.com.br'),
  ('04150555001142','atendimento@dmillenium.com.br'),
  ('44039854000238','ingrid.campos@friorio.com.br'),
  ('06043130000198','galdiani.logistica@coletek.com.br'),
  ('02274279000127','faturamento@binariotecnologia.com.br'),
  ('30055933000651','vinicius.oliveira@stanley1913.com'),
  ('04150555000685','atendimento@dmillenium.com.br')
) AS v(cnpj, email)
WHERE NOT EXISTS (
  SELECT 1 FROM contatos_cliente c
   WHERE c.documento_cliente = v.cnpj
     AND lower(c.identificador) = lower(v.email)
);

-- ---------------------------------------------------------------------------
-- 3) VICTOR: carteira += 9 CNPJs e segmentos += {012,013,020,041} (dedup, ADITIVO)
-- ---------------------------------------------------------------------------
UPDATE operadores
   SET carteira = (
         SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(
           coalesce(carteira,'{}'::text[]) || ARRAY[
             '09316105000471','30901791000272','08382929002188','04150555001142',
             '44039854000238','06043130000198','02274279000127','30055933000651',
             '04150555000685'
           ]
         ) AS x),
       segmentos = (
         SELECT array_agg(DISTINCT s ORDER BY s) FROM unnest(
           coalesce(segmentos,'{}'::text[]) || ARRAY['012','013','020','041']
         ) AS s)
 WHERE id = :'victor_id'::uuid;

-- ---------------------------------------------------------------------------
-- 4) ISA E KAROL: remove FRIORIO da carteira (dono único)
-- ---------------------------------------------------------------------------
UPDATE operadores
   SET carteira = array_remove(coalesce(carteira,'{}'::text[]), '44039854000238')
 WHERE id = :'isakarol_id'::uuid;

-- ---------------------------------------------------------------------------
-- 5) Cards existentes desses CNPJs -> Victor (event sourcing: evento ANTES do update)
--    Set assigned_operator_id explícito (NOT NULL) => trigger resolve_operator no-op.
-- ---------------------------------------------------------------------------
-- 5a) Evento por card (lê o dono ANTIGO antes de mudar)
INSERT INTO card_events (card_id, event_type, payload, actor_type, actor_id)
SELECT c.id, 'CardReatribuido',
       jsonb_build_object(
         'para',            'VICTOR',
         'origem',          'onboarding diversos victor (012/013/020/041) 2026-06-23',
         'de_operador_id',  c.assigned_operator_id,
         'cnpj_pagador',    c.agent_state->>'cnpj_pagador',
         'state_no_momento',c.state
       ),
       'system', 'diversos-victor-2026-06-23'
  FROM cards c
 WHERE (c.agent_state->>'cnpj_pagador') IN (
         '09316105000471','30901791000272','08382929002188','04150555001142',
         '44039854000238','06043130000198','02274279000127','30055933000651',
         '04150555000685')
   AND c.assigned_operator_id IS DISTINCT FROM :'victor_id'::uuid;

-- 5b) Re-atribui
UPDATE cards
   SET assigned_operator_id       = :'victor_id'::uuid,
       responsavel_relacionamento = 'VICTOR'
 WHERE (agent_state->>'cnpj_pagador') IN (
         '09316105000471','30901791000272','08382929002188','04150555001142',
         '44039854000238','06043130000198','02274279000127','30055933000651',
         '04150555000685')
   AND assigned_operator_id IS DISTINCT FROM :'victor_id'::uuid;

-- ===========================================================================
-- VERIFICAÇÃO (imprime no mesmo tx, antes do COMMIT/ROLLBACK)
-- ===========================================================================
\echo '--- VICTOR (carteira/segmentos) ---'
SELECT nome, cockpit_ativo, array_length(carteira,1) AS n_carteira, segmentos
  FROM operadores WHERE id = :'victor_id'::uuid;

\echo '--- 9 CNPJs estao na carteira do VICTOR? (espera 9) ---'
SELECT count(*) AS na_carteira_victor
  FROM operadores, unnest(ARRAY[
    '09316105000471','30901791000272','08382929002188','04150555001142',
    '44039854000238','06043130000198','02274279000127','30055933000651','04150555000685']) cnpj
 WHERE id = :'victor_id'::uuid AND cnpj = ANY(carteira);

\echo '--- FRIORIO saiu da ISA/Karol? (espera 0) ---'
SELECT count(*) AS friorio_ainda_na_isa
  FROM operadores WHERE id = :'isakarol_id'::uuid AND '44039854000238' = ANY(carteira);

\echo '--- Overlap de CNPJ entre VICTOR e outros operadores ATIVOS (espera 0) ---'
SELECT o.nome AS outro_operador, count(*) AS cnpjs_em_comum
  FROM operadores v, operadores o
 WHERE v.id = :'victor_id'::uuid AND o.id <> v.id
   AND o.ativo AND o.cockpit_ativo AND v.carteira && o.carteira
 GROUP BY o.nome;

\echo '--- Contatos dos 9 CNPJs (operador responsavel) ---'
SELECT cc.documento_cliente, cc.identificador, o.nome AS operador
  FROM contatos_cliente cc LEFT JOIN operadores o ON o.id = cc.operador_responsavel_id
 WHERE cc.documento_cliente IN (
   '09316105000471','30901791000272','08382929002188','04150555001142',
   '44039854000238','06043130000198','02274279000127','30055933000651','04150555000685')
 ORDER BY cc.documento_cliente, cc.identificador;

\echo '--- Cards desses CNPJs por operador (espera todos = VICTOR) ---'
SELECT (c.agent_state->>'cnpj_pagador') AS cnpj, c.state, o.nome AS assigned_op, count(*) AS n
  FROM cards c LEFT JOIN operadores o ON o.id = c.assigned_operator_id
 WHERE (c.agent_state->>'cnpj_pagador') IN (
   '09316105000471','30901791000272','08382929002188','04150555001142',
   '44039854000238','06043130000198','02274279000127','30055933000651','04150555000685')
 GROUP BY 1,2,3 ORDER BY 1,2;

\echo '--- Eventos CardReatribuido criados neste run ---'
SELECT count(*) AS eventos_criados
  FROM card_events
 WHERE event_type='CardReatribuido' AND actor_id='diversos-victor-2026-06-23';
