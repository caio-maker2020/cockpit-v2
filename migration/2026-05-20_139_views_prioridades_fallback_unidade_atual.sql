-- ============================================================================
-- Cockpit v2 — fallback base_destino → unidade_atual nas views PRIORIDADES AI
-- Caio 2026-05-20
--
-- Bug NF 2296843: Bastão (RPA SSW) só popula cards.base_destino quando a carga
-- chega na BASE OPERACIONAL OFICIAL (ex: "COR"/CORINTO). Quando está em
-- sub-unidade (ex: "CVL"/Curvelo), base_destino vem null mas unidade_atual
-- tem a sigla. Front da aba PRIORIDADES AI mostrava vazio na coluna "base".
--
-- Fix: COALESCE(c.base_destino, c.agent_state->>'unidade_atual') AS base_destino
-- nas 2 views consumidas pelo kanban — oc13 e oc21. Nome do campo retornado
-- continua "base_destino" pro front não mudar nada.
--
-- security_invoker=on preservado (RLS de cards aplicado).
-- ============================================================================

CREATE OR REPLACE VIEW public.v_oc13_paradas_prioridades
WITH (security_invoker = on) AS
WITH historico_eventos AS (
  SELECT
    c.id AS card_id,
    ((h.elem ->> 'codigo')::integer) AS codigo,
    ((
      '20' || split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 3) || '-' ||
      lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 2), 2, '0') || '-' ||
      lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 1), 2, '0') || ' ' ||
      split_part(h.elem ->> 'data', ' ', 2) || ':00-03'
    ))::timestamptz AS data_evento
  FROM public.cards c
  CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) h(elem)
  WHERE c.historico_ssw IS NOT NULL
    AND ((h.elem ->> 'codigo')::integer) IS NOT NULL
    AND (h.elem ->> 'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
),
ultima_oc_atual AS (
  SELECT card_id, MAX(data_evento) AS ts_atual
  FROM historico_eventos
  WHERE codigo = 13
  GROUP BY card_id
)
SELECT
  c.id AS card_id,
  c.nf, c.ctrc, c.tipo_cte,
  c.responsavel_relacionamento,
  COALESCE(c.base_destino, c.agent_state->>'unidade_atual') AS base_destino,
  c.pagador AS pagador_nome,
  c.agent_state ->> 'cnpj_pagador' AS cnpj_pagador,
  c.empresa_cliente,
  c.nome_cliente,
  c.state,
  c.assigned_operator_id,
  COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at - interval '1 day'
  ) AS data_oc13,
  round(EXTRACT(epoch FROM now() - COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at
  )) / 60)::int AS minutos_paradas,
  round(EXTRACT(epoch FROM now() - COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at
  )) / 3600, 1) AS horas_paradas,
  round(public.dias_uteis_entre(COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at
  ), now()), 2) AS dias_uteis_parados,
  public.dias_uteis_entre(COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at
  ), now()) <= 1 AS dentro_sla
FROM public.cards c
WHERE c.cod_ultima_ocorrencia = 13
  AND c.responsavel_relacionamento IS NOT NULL
  AND c.state NOT IN ('RESOLVIDO','CANCELADO')
  AND NOT EXISTS (
    SELECT 1
    FROM historico_eventos h
    LEFT JOIN ultima_oc_atual u ON u.card_id = h.card_id
    WHERE h.card_id = c.id
      AND h.codigo <> 13
      AND u.ts_atual IS NOT NULL
      AND h.data_evento > u.ts_atual
  )
ORDER BY public.dias_uteis_entre(COALESCE(
  (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
  c.updated_at
), now()) DESC NULLS LAST;


CREATE OR REPLACE VIEW public.v_oc21_paradas_prioridades
WITH (security_invoker = on) AS
WITH historico_eventos AS (
  SELECT
    c.id AS card_id,
    ((h.elem ->> 'codigo')::integer) AS codigo,
    ((
      '20' || split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 3) || '-' ||
      lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 2), 2, '0') || '-' ||
      lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 1), 2, '0') || ' ' ||
      split_part(h.elem ->> 'data', ' ', 2) || ':00-03'
    ))::timestamptz AS data_evento
  FROM public.cards c
  CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) h(elem)
  WHERE c.historico_ssw IS NOT NULL
    AND ((h.elem ->> 'codigo')::integer) IS NOT NULL
    AND (h.elem ->> 'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
),
ultima_oc_atual AS (
  SELECT card_id, MAX(data_evento) AS ts_atual
  FROM historico_eventos
  WHERE codigo = 21
  GROUP BY card_id
)
SELECT
  c.id AS card_id,
  c.nf, c.ctrc, c.tipo_cte,
  c.responsavel_relacionamento,
  COALESCE(c.base_destino, c.agent_state->>'unidade_atual') AS base_destino,
  c.pagador AS pagador_nome,
  c.agent_state ->> 'cnpj_pagador' AS cnpj_pagador,
  c.empresa_cliente,
  c.nome_cliente,
  c.state,
  c.assigned_operator_id,
  COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at - interval '1 day'
  ) AS data_oc21,
  round(EXTRACT(epoch FROM now() - COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at
  )) / 60)::int AS minutos_paradas,
  round(EXTRACT(epoch FROM now() - COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at
  )) / 3600, 1) AS horas_paradas,
  round(public.dias_uteis_entre(COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at
  ), now()), 2) AS dias_uteis_parados,
  public.dias_uteis_entre(COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at
  ), now()) <= 1 AS dentro_sla
FROM public.cards c
WHERE c.cod_ultima_ocorrencia = 21
  AND c.responsavel_relacionamento IS NOT NULL
  AND c.state NOT IN ('RESOLVIDO','CANCELADO')
  AND NOT EXISTS (
    SELECT 1
    FROM historico_eventos h
    LEFT JOIN ultima_oc_atual u ON u.card_id = h.card_id
    WHERE h.card_id = c.id
      AND h.codigo <> 21
      AND u.ts_atual IS NOT NULL
      AND h.data_evento > u.ts_atual
  )
ORDER BY public.dias_uteis_entre(COALESCE(
  (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
  c.updated_at
), now()) DESC NULLS LAST;
