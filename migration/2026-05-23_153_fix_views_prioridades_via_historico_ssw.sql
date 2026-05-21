-- ============================================================================
-- Cockpit v2 — fix CRÍTICO views v_oc21_paradas_prioridades + v_oc13_paradas_prioridades
-- Caio 2026-05-23
--
-- BUG: cards com oc=21 (ou oc=13) lançada pelo Cockpit estavam sumindo da
-- aba PRIORIDADES AI por causa de DESSINCRONIZAÇÃO do campo `cards.cod_ultima_ocorrencia`.
-- 4 cards perdidos identificados em 2026-05-23 (NFs 1494315, 1492103, 2306334,
-- 2302499 — todos do DUILIO):
--
--   Caso âncora NF 1494315 (DUILIO/FERRAMENTAS GERAIS):
--   - Cockpit lançou oc=21 com sucesso em 20/05 14:37 (AcaoExecutada confirmada)
--   - SSW real registra oc=21 como evento mais recente (20/05 11:37 SSW time)
--   - Mas cards.cod_ultima_ocorrencia regrediu pra 8 (latência Bastão + Pass A)
--   - View v_oc21_paradas_prioridades filtrava `cod_ultima_ocorrencia=21` →
--     NÃO incluía esse card → invisível em PRIORIDADES AI
--
-- CAUSA RAIZ:
--   Views confiavam em `cards.cod_ultima_ocorrencia` (campo cacheado que
--   pode dessincronizar) em vez de ler o HISTÓRICO SSW REAL.
--
-- REGRA CANÔNICA (Caio 2026-05-23):
--   Card aparece em PRIORIDADES AI se:
--   (a) Tem evento oc=21 (ou oc=13) no historico_ssw
--   (b) NÃO tem oc DE RELACIONAMENTO {3,8,10,11,17,19,20,23,26,28,35,43,49,52,54}
--       lançada POSTERIORMENTE à oc=21/13 (essas vão pro Cockpit primário)
--   (c) NÃO tem oc FINALIZADORA {1,14,30,32} posterior (essas vão pra coluna RESOLVIDO
--       — não somem do kanban; o cron sync atualiza o kanban_status)
--   (d) state NOT IN (RESOLVIDO, CANCELADO)
--   (e) responsavel_relacionamento IS NOT NULL E ctrc IS NOT NULL
--   (f) Pra oc=13: cnpj_pagador NOT IN cliente_config_oc13 (esses primeiramente
--       vão pro Cockpit como relacionamento)
--
-- Lógica espelha a mig 150 (v_oc21_aguardando_oc14_inclui_transferido) que já
-- corrigiu problema análogo no SLA alerts. Aplicação consistente da regra
-- "olhar histórico SSW, não confiar em cod_ultima_ocorrencia".
--
-- skill: supabase-postgres-best-practices
--   * DROP VIEW CASCADE seguro (vamos recriar v_prioridades_ai também)
--   * security_invoker=on (memory feedback_views_publicas_security_invoker)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. v_oc21_paradas_prioridades — olha histórico SSW
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_oc21_paradas_prioridades CASCADE;

CREATE VIEW public.v_oc21_paradas_prioridades
WITH (security_invoker = on) AS
WITH historico_eventos AS (
  SELECT
    c.id AS card_id,
    ((h.elem ->> 'codigo')::int) AS codigo,
    (((((((('20'::text || split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 3))
      || '-'::text) || lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 2), 2, '0'))
      || '-'::text) || lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 1), 2, '0'))
      || ' '::text) || split_part(h.elem ->> 'data', ' ', 2)) || ':00-03'::text)::timestamptz AS data_evento
  FROM public.cards c
  CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) h(elem)
  WHERE c.historico_ssw IS NOT NULL
    AND (h.elem ->> 'codigo') IS NOT NULL
    AND (h.elem ->> 'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
),
ult_oc21 AS (
  SELECT card_id, MAX(data_evento) AS ts21
  FROM historico_eventos
  WHERE codigo = 21
  GROUP BY card_id
),
filtrar AS (
  SELECT u.card_id, u.ts21
  FROM ult_oc21 u
  WHERE NOT EXISTS (
    -- oc de RELACIONAMENTO posterior → exclui (vai pro Cockpit primário)
    SELECT 1 FROM historico_eventos h
    WHERE h.card_id = u.card_id
      AND h.data_evento > u.ts21
      AND h.codigo IN (3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49, 52, 54)
  )
  AND NOT EXISTS (
    -- oc FINALIZADORA posterior → exclui (entregue/baixado)
    SELECT 1 FROM historico_eventos h
    WHERE h.card_id = u.card_id
      AND h.data_evento > u.ts21
      AND h.codigo IN (1, 14, 30, 32)
  )
)
SELECT
  c.id AS card_id,
  c.nf,
  c.ctrc,
  c.tipo_cte,
  c.responsavel_relacionamento,
  COALESCE(c.base_destino, c.agent_state ->> 'unidade_atual') AS base_destino,
  c.pagador AS pagador_nome,
  c.agent_state ->> 'cnpj_pagador' AS cnpj_pagador,
  c.empresa_cliente,
  c.nome_cliente,
  c.state,
  c.assigned_operator_id,
  f.ts21 AS data_oc21,
  round(EXTRACT(epoch FROM now() - f.ts21) / 60::numeric)::int AS minutos_paradas,
  round(EXTRACT(epoch FROM now() - f.ts21) / 3600::numeric, 1) AS horas_paradas,
  round(public.dias_uteis_entre(f.ts21, now()), 2) AS dias_uteis_parados,
  public.dias_uteis_entre(f.ts21, now()) <= 1::numeric AS dentro_sla
FROM filtrar f
JOIN public.cards c ON c.id = f.card_id
WHERE c.responsavel_relacionamento IS NOT NULL
  AND c.ctrc IS NOT NULL
  AND c.state NOT IN ('RESOLVIDO', 'CANCELADO')
ORDER BY public.dias_uteis_entre(f.ts21, now()) DESC NULLS LAST;

GRANT SELECT ON public.v_oc21_paradas_prioridades TO authenticated, service_role;

COMMENT ON VIEW public.v_oc21_paradas_prioridades IS
  'v3 Caio 2026-05-23: olha histórico SSW (não confia em cod_ultima_ocorrencia). '
  'Inclui se: tem oc=21 + NÃO tem relacionamento posterior + NÃO tem finalizadora. '
  'Fix bug NFs 1494315/1492103/2306334/2302499 invisíveis em PRIORIDADES AI.';


-- ---------------------------------------------------------------------------
-- 2. v_oc13_paradas_prioridades — mesma lógica robusta (preventiva)
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_oc13_paradas_prioridades CASCADE;

CREATE VIEW public.v_oc13_paradas_prioridades
WITH (security_invoker = on) AS
WITH historico_eventos AS (
  SELECT
    c.id AS card_id,
    ((h.elem ->> 'codigo')::int) AS codigo,
    (((((((('20'::text || split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 3))
      || '-'::text) || lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 2), 2, '0'))
      || '-'::text) || lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 1), 2, '0'))
      || ' '::text) || split_part(h.elem ->> 'data', ' ', 2)) || ':00-03'::text)::timestamptz AS data_evento
  FROM public.cards c
  CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) h(elem)
  WHERE c.historico_ssw IS NOT NULL
    AND (h.elem ->> 'codigo') IS NOT NULL
    AND (h.elem ->> 'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
),
ult_oc13 AS (
  SELECT card_id, MAX(data_evento) AS ts13
  FROM historico_eventos
  WHERE codigo = 13
  GROUP BY card_id
),
filtrar AS (
  SELECT u.card_id, u.ts13
  FROM ult_oc13 u
  WHERE NOT EXISTS (
    SELECT 1 FROM historico_eventos h
    WHERE h.card_id = u.card_id
      AND h.data_evento > u.ts13
      AND h.codigo IN (3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49, 52, 54)
  )
  AND NOT EXISTS (
    SELECT 1 FROM historico_eventos h
    WHERE h.card_id = u.card_id
      AND h.data_evento > u.ts13
      AND h.codigo IN (1, 14, 30, 32)
  )
  AND NOT EXISTS (
    -- oc=21 posterior à oc=13 → sai (já está/vai pra view oc=21)
    SELECT 1 FROM historico_eventos h
    WHERE h.card_id = u.card_id
      AND h.data_evento > u.ts13
      AND h.codigo = 21
  )
)
SELECT
  c.id AS card_id,
  c.nf,
  c.ctrc,
  c.tipo_cte,
  c.responsavel_relacionamento,
  COALESCE(c.base_destino, c.agent_state ->> 'unidade_atual') AS base_destino,
  c.pagador AS pagador_nome,
  c.agent_state ->> 'cnpj_pagador' AS cnpj_pagador,
  c.empresa_cliente,
  c.nome_cliente,
  c.state,
  c.assigned_operator_id,
  f.ts13 AS data_oc13,
  round(EXTRACT(epoch FROM now() - f.ts13) / 60::numeric)::int AS minutos_paradas,
  round(EXTRACT(epoch FROM now() - f.ts13) / 3600::numeric, 1) AS horas_paradas,
  round(public.dias_uteis_entre(f.ts13, now()), 2) AS dias_uteis_parados,
  public.dias_uteis_entre(f.ts13, now()) <= 1::numeric AS dentro_sla
FROM filtrar f
JOIN public.cards c ON c.id = f.card_id
WHERE c.responsavel_relacionamento IS NOT NULL
  AND c.ctrc IS NOT NULL
  AND c.state NOT IN ('RESOLVIDO', 'CANCELADO')
  -- EXCEÇÃO oc=13: clientes em cliente_config_oc13 vão pro Cockpit como relacionamento
  AND (c.agent_state ->> 'cnpj_pagador') NOT IN (
    SELECT cnpj_pagador FROM public.cliente_config_oc13 WHERE ativo
  )
ORDER BY public.dias_uteis_entre(f.ts13, now()) DESC NULLS LAST;

GRANT SELECT ON public.v_oc13_paradas_prioridades TO authenticated, service_role;

COMMENT ON VIEW public.v_oc13_paradas_prioridades IS
  'v3 Caio 2026-05-23: olha histórico SSW + mantém exceção cliente_config_oc13. '
  'Inclui se: tem oc=13 + NÃO tem relacionamento/finalizadora/oc=21 posterior + '
  'cnpj não está na allowlist exceção.';


-- ---------------------------------------------------------------------------
-- 3. v_prioridades_ai — UNION (precisa recriar pois views base foram dropadas)
--    Espelha definição original (mig 127/132/143) — apenas re-aponta.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_prioridades_ai CASCADE;

CREATE VIEW public.v_prioridades_ai
WITH (security_invoker = on) AS
WITH paradas AS (
  SELECT card_id, nf, ctrc, tipo_cte, responsavel_relacionamento, base_destino,
         pagador_nome, cnpj_pagador, empresa_cliente, nome_cliente,
         state, assigned_operator_id, data_oc21 AS data_anchora,
         minutos_paradas, horas_paradas, dias_uteis_parados, dentro_sla,
         21 AS oc_origem
  FROM public.v_oc21_paradas_prioridades
  UNION ALL
  SELECT card_id, nf, ctrc, tipo_cte, responsavel_relacionamento, base_destino,
         pagador_nome, cnpj_pagador, empresa_cliente, nome_cliente,
         state, assigned_operator_id, data_oc13 AS data_anchora,
         minutos_paradas, horas_paradas, dias_uteis_parados, dentro_sla,
         13 AS oc_origem
  FROM public.v_oc13_paradas_prioridades
)
SELECT
  p.*,
  c.prioridades_kanban_status AS coluna_kanban,
  c.pagador,
  -- última análise IA (priorizador OR monitor)
  (SELECT jsonb_build_object(
      'tipo', a.tipo,
      'rank_priorizador', a.rank_priorizador,
      'observacao_priorizador', a.observacao_priorizador,
      'veredito_monitor', a.veredito_monitor,
      'proxima_acao_monitor', a.proxima_acao_monitor,
      'analisado_em', a.analisado_em)
     FROM public.analises_prioridades_ai a
     WHERE a.card_id = p.card_id
     ORDER BY a.analisado_em DESC LIMIT 1) AS ia_insight,
  -- última cobrança
  (SELECT jsonb_build_object('papel', cb.papel, 'canal', cb.canal, 'em', cb.disparado_em)
     FROM public.cobrancas_disparadas cb
     WHERE cb.card_id = p.card_id ORDER BY cb.disparado_em DESC LIMIT 1) AS ult_cobranca,
  EXISTS (SELECT 1 FROM public.cobrancas_disparadas WHERE card_id=p.card_id AND papel='gerente_base') AS ja_cobrou_gerente_base,
  EXISTS (SELECT 1 FROM public.cobrancas_disparadas WHERE card_id=p.card_id AND papel='coordenador_entrega') AS ja_cobrou_coordenador,
  EXISTS (SELECT 1 FROM public.cobrancas_disparadas WHERE card_id=p.card_id AND papel='gerente_relacionamento') AS ja_cobrou_gerente_rel
FROM paradas p
JOIN public.cards c ON c.id = p.card_id;

GRANT SELECT ON public.v_prioridades_ai TO authenticated, service_role;

COMMENT ON VIEW public.v_prioridades_ai IS
  'v4 Caio 2026-05-23: UNION das views v3 (olhar histórico SSW). Inclui ia_insight + ult_cobranca.';
