-- =============================================================================
-- preflight-checks.sql — Verificação READ-ONLY antes de aplicar a mig 300
-- =============================================================================
-- Onboarding KAROLINE (herda clientes da LARISSA). Rode ISTO ANTES da migration.
-- Tudo em transação READ ONLY: o Postgres aborta qualquer escrita acidental.
--
--   psql "$SUPABASE_DB_URL" -f docs/operadoras/karoline/preflight-checks.sql
--
-- Pré-requisito: cole a MESMA lista de CNPJs da planilha no bloco _plan abaixo
-- (só os CNPJs; sem nome/email). Serve pra provar 0-conflito e contar o que move.
-- =============================================================================
BEGIN;
SET TRANSACTION READ ONLY;

-- >>>>>>>>>>>>>> COLE OS CNPJs DA PLANILHA AQUI (só dígitos ou com máscara) >>>>>
CREATE TEMP TABLE _plan (cnpj_raw text) ON COMMIT DROP;
INSERT INTO _plan (cnpj_raw) VALUES
  ('00000000000000'),
  ('11111111111111');
-- <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
-- cru (sem lpad) — casa com carteira/clientes/tracking (§2-§4). Nas seções de card
-- (§5-§8) o match aplica lpad(14) nos dois lados, igual à migration.
CREATE TEMP TABLE _cnpj ON COMMIT DROP AS
SELECT DISTINCT regexp_replace(cnpj_raw, '\D', '', 'g') AS cnpj FROM _plan;

\echo '=== 0. Estado atual da LARISSA (contagem carteira/segmentos) ==='
SELECT nome, ativo, cockpit_ativo,
       cardinality(carteira)  AS carteira_qtd,
       segmentos
FROM public.operadores WHERE nome = 'LARISSA';

\echo '=== 1. KAROLINE já existe? (esperado: 0 linhas antes do 1º run) ==='
SELECT nome, ativo, cockpit_ativo, cardinality(carteira) AS carteira_qtd, user_id
FROM public.operadores WHERE nome = 'KAROLINE';

\echo '=== 2. GUARDA G4 — CNPJ da planilha em carteira de operador ATIVO ≠ LARISSA (esperado: 0) ==='
SELECT o.nome AS operador_conflitante, c.cnpj
FROM _cnpj c
JOIN public.operadores o
  ON c.cnpj = ANY(o.carteira) AND o.ativo = true AND o.nome <> 'LARISSA'
ORDER BY 1, 2;

\echo '=== 3. Quais CNPJs da planilha estão HOJE na carteira da LARISSA (o que vai sair dela) ==='
SELECT c.cnpj,
       (c.cnpj = ANY(l.carteira)) AS na_carteira_larissa
FROM _cnpj c
CROSS JOIN (SELECT carteira FROM public.operadores WHERE nome = 'LARISSA') l
ORDER BY 1;

\echo '=== 4. CNPJ da planilha que NÃO está em nenhuma carteira (novo/órfão — só entra na Karoline) ==='
SELECT c.cnpj
FROM _cnpj c
WHERE NOT EXISTS (
  SELECT 1 FROM public.operadores o WHERE c.cnpj = ANY(o.carteira)
)
ORDER BY 1;

\echo '=== 5. Cards NÃO-terminais que serão MOVIDOS (por cnpj_pagador) — snapshot ANTES ==='
SELECT count(*) AS cards_a_mover,
       count(*) FILTER (WHERE assigned_operator_id IS NULL) AS orfaos_incluidos,
       count(DISTINCT lpad(regexp_replace(agent_state->>'cnpj_pagador','\D','','g'),14,'0')) AS cnpjs_com_card
FROM public.cards c
WHERE lpad(regexp_replace(c.agent_state->>'cnpj_pagador','\D','','g'),14,'0') IN (SELECT lpad(cnpj,14,'0') FROM _cnpj)
  AND c.state NOT IN ('RESOLVIDO','CANCELADO')
  AND (c.assigned_operator_id = (SELECT id FROM public.operadores WHERE nome='LARISSA')
       OR c.assigned_operator_id IS NULL);

\echo '=== 6. Detalhe dos cards a mover (confirmar que são todos da LARISSA/órfãos) ==='
SELECT c.nf, c.ctrc, c.state, c.cod_ultima_ocorrencia,
       lpad(regexp_replace(c.agent_state->>'cnpj_pagador','\D','','g'),14,'0') AS cnpj,
       c.responsavel_relacionamento, c.assigned_operator_id, c.segmento_codigo
FROM public.cards c
WHERE lpad(regexp_replace(c.agent_state->>'cnpj_pagador','\D','','g'),14,'0') IN (SELECT lpad(cnpj,14,'0') FROM _cnpj)
  AND c.state NOT IN ('RESOLVIDO','CANCELADO')
ORDER BY c.responsavel_relacionamento NULLS FIRST, cnpj, c.nf;

\echo '=== 7. ALERTA — cards desses CNPJs presos em OUTRO operador ativo (deve ser 0; senão revisar) ==='
SELECT o.nome AS dono_atual, count(*) AS cards
FROM public.cards c
JOIN public.operadores o ON o.id = c.assigned_operator_id AND o.ativo = true
WHERE lpad(regexp_replace(c.agent_state->>'cnpj_pagador','\D','','g'),14,'0') IN (SELECT lpad(cnpj,14,'0') FROM _cnpj)
  AND c.state NOT IN ('RESOLVIDO','CANCELADO')
  AND o.nome NOT IN ('LARISSA','KAROLINE')
GROUP BY 1 ORDER BY 2 DESC;

\echo '=== 8. Threads de e-mail vivas desses clientes (contexto p/ guarda da Gmail da Larissa) ==='
SELECT count(DISTINCT ceo.gmail_thread_id) AS threads_outbound
FROM public.cards_emails_outbound ceo
JOIN public.cards c ON c.id = ceo.card_id
WHERE lpad(regexp_replace(c.agent_state->>'cnpj_pagador','\D','','g'),14,'0') IN (SELECT lpad(cnpj,14,'0') FROM _cnpj);

ROLLBACK;
-- Nada foi escrito (READ ONLY + ROLLBACK). Rodável quantas vezes quiser.
