-- ============================================================================
-- Cockpit v2 — views de prioridade (v_oc21/v_oc13_paradas_prioridades) incluem a
--               oc 59 na lista "card avançou além da parada" (separação 54/59)
-- Data: 2026-07-13 (Caio — separação 54/59, Bloco 7)
-- skill: supabase-postgres-best-practices
--
-- CONTEXTO: as views que listam cards "parados" na oc21/oc13 excluem cards que
-- JÁ avançaram — via `codigo IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52,54)`
-- (ocs de relacionamento + a 54 de aguardando-cliente) num evento POSTERIOR à
-- parada. Com a separação 54/59, a 59 (RETORNO INDENIZAÇÃO) é análoga à 54: um
-- card que chegou na 59 avançou além da parada. Sem incluir 59, esse card
-- apareceria ERRADAMENTE como "ainda parado" nas telas de prioridade oc21/oc13.
--
-- Fix cirúrgico: adiciona 59 às DUAS listas (v_oc21 e v_oc13). Colunas de saída
-- inalteradas → CREATE OR REPLACE VIEW (não dropa; a v_prioridades_ai dependente
-- fica intacta). security_invoker=on preservado (mig 155 é a versão viva; 215 só
-- dropou outras views).
--
-- skill checklist:
--   - CREATE OR REPLACE VIEW (colunas idênticas → sem CASCADE) ✓
--   - security_invoker = on preservado (views públicas, PG15+) ✓
--   - GRANT SELECT reafirmado ✓
-- ============================================================================

CREATE OR REPLACE VIEW public.v_oc21_paradas_prioridades
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
  SELECT card_id, MAX(data_evento) AS ts21 FROM historico_eventos WHERE codigo=21 GROUP BY card_id
),
filtrar AS (
  SELECT u.card_id, u.ts21
  FROM ult_oc21 u
  WHERE NOT EXISTS (SELECT 1 FROM historico_eventos h WHERE h.card_id=u.card_id AND h.data_evento>u.ts21 AND h.codigo IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52,54,59))
  AND NOT EXISTS (SELECT 1 FROM historico_eventos h WHERE h.card_id=u.card_id AND h.data_evento>u.ts21 AND h.codigo IN (1,14,30,32))
)
SELECT
  c.id AS card_id, c.nf, c.ctrc, c.tipo_cte,
  c.responsavel_relacionamento,
  COALESCE(c.base_destino, c.agent_state->>'unidade_atual') AS base_destino,
  c.agent_state->>'cidade_destino' AS cidade_destino,
  c.agent_state->>'uf_destino' AS uf_destino,
  c.pagador AS pagador_nome,
  c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
  c.empresa_cliente, c.nome_cliente,
  c.state, c.assigned_operator_id,
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
  'v5 Caio 2026-07-13 (separação 54/59): 59 (RETORNO INDENIZAÇÃO) entra na lista "avançou além da parada" junto com a 54. Expõe cidade_destino + uf_destino.';


CREATE OR REPLACE VIEW public.v_oc13_paradas_prioridades
WITH (security_invoker = on) AS
WITH historico_eventos AS (
  SELECT c.id AS card_id, ((h.elem ->> 'codigo')::int) AS codigo,
    (((((((('20'::text || split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 3))
      || '-'::text) || lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 2), 2, '0'))
      || '-'::text) || lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 1), 2, '0'))
      || ' '::text) || split_part(h.elem ->> 'data', ' ', 2)) || ':00-03'::text)::timestamptz AS data_evento
  FROM public.cards c CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) h(elem)
  WHERE c.historico_ssw IS NOT NULL AND (h.elem ->> 'codigo') IS NOT NULL
    AND (h.elem ->> 'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
),
ult_oc13 AS (SELECT card_id, MAX(data_evento) AS ts13 FROM historico_eventos WHERE codigo=13 GROUP BY card_id),
filtrar AS (
  SELECT u.card_id, u.ts13 FROM ult_oc13 u
  WHERE NOT EXISTS (SELECT 1 FROM historico_eventos h WHERE h.card_id=u.card_id AND h.data_evento>u.ts13 AND h.codigo IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52,54,59))
  AND NOT EXISTS (SELECT 1 FROM historico_eventos h WHERE h.card_id=u.card_id AND h.data_evento>u.ts13 AND h.codigo IN (1,14,30,32))
  AND NOT EXISTS (SELECT 1 FROM historico_eventos h WHERE h.card_id=u.card_id AND h.data_evento>u.ts13 AND h.codigo=21)
)
SELECT
  c.id AS card_id, c.nf, c.ctrc, c.tipo_cte,
  c.responsavel_relacionamento,
  COALESCE(c.base_destino, c.agent_state->>'unidade_atual') AS base_destino,
  c.agent_state->>'cidade_destino' AS cidade_destino,
  c.agent_state->>'uf_destino' AS uf_destino,
  c.pagador AS pagador_nome,
  c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
  c.empresa_cliente, c.nome_cliente,
  c.state, c.assigned_operator_id,
  f.ts13 AS data_oc13,
  round(EXTRACT(epoch FROM now() - f.ts13) / 60::numeric)::int AS minutos_paradas,
  round(EXTRACT(epoch FROM now() - f.ts13) / 3600::numeric, 1) AS horas_paradas,
  round(public.dias_uteis_entre(f.ts13, now()), 2) AS dias_uteis_parados,
  public.dias_uteis_entre(f.ts13, now()) <= 1::numeric AS dentro_sla
FROM filtrar f JOIN public.cards c ON c.id = f.card_id
WHERE c.responsavel_relacionamento IS NOT NULL AND c.ctrc IS NOT NULL
  AND c.state NOT IN ('RESOLVIDO', 'CANCELADO')
  AND (c.agent_state->>'cnpj_pagador') NOT IN (SELECT cnpj_pagador FROM public.cliente_config_oc13 WHERE ativo)
ORDER BY public.dias_uteis_entre(f.ts13, now()) DESC NULLS LAST;

GRANT SELECT ON public.v_oc13_paradas_prioridades TO authenticated, service_role;

COMMENT ON VIEW public.v_oc13_paradas_prioridades IS
  'v5 Caio 2026-07-13 (separação 54/59): 59 (RETORNO INDENIZAÇÃO) entra na lista "avançou além da parada" junto com a 54. Expõe cidade_destino + uf_destino.';
