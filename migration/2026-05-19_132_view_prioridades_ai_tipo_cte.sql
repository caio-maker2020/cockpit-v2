-- ============================================================================
-- Cockpit v2 — v_prioridades_ai expõe tipo_cte
-- Data: 2026-05-19
--
-- Caio: aba PRIORIDADES AI precisa mostrar tipo do CT-e
-- (NORMAL/REVERSA/COMPLEMENTAR/SUBSTITUTO) — info que ajuda operador a
-- entender o caso antes de cobrar.
--
-- Atualiza views base + view unificada.
-- ============================================================================

DROP VIEW IF EXISTS public.v_prioridades_ai CASCADE;
DROP VIEW IF EXISTS public.v_oc21_paradas_prioridades CASCADE;
DROP VIEW IF EXISTS public.v_oc13_paradas CASCADE;

-- v_oc21_paradas_prioridades — adiciona tipo_cte
CREATE VIEW public.v_oc21_paradas_prioridades
WITH (security_invoker = on) AS
WITH historico_eventos AS (
  SELECT
    c.id AS card_id,
    (h.elem->>'codigo')::int AS codigo,
    (
      '20' || split_part(split_part(h.elem->>'data', ' ', 1), '/', 3) || '-' ||
      lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 2), 2, '0') || '-' ||
      lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 1), 2, '0') || ' ' ||
      split_part(h.elem->>'data', ' ', 2) || ':00-03'
    )::timestamptz AS data_evento
  FROM public.cards c
  CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) AS h(elem)
  WHERE c.historico_ssw IS NOT NULL
    AND (h.elem->>'codigo')::int IS NOT NULL
    AND (h.elem->>'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
)
SELECT
  c.id AS card_id,
  c.nf,
  c.ctrc,
  c.tipo_cte,
  c.responsavel_relacionamento,
  c.base_destino,
  c.pagador AS pagador_nome,
  c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
  c.empresa_cliente,
  c.nome_cliente,
  c.state,
  c.assigned_operator_id,
  COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at - interval '1 day'
  ) AS data_oc21,
  ROUND(EXTRACT(EPOCH FROM (now() - COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at
  ))) / 60)::int AS minutos_paradas,
  ROUND(EXTRACT(EPOCH FROM (now() - COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at
  ))) / 3600, 1) AS horas_paradas,
  ROUND(public.dias_uteis_entre(
    COALESCE(
      (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
      c.updated_at
    ), now()
  ), 2) AS dias_uteis_parados,
  (public.dias_uteis_entre(
    COALESCE(
      (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
      c.updated_at
    ), now()
  ) <= 1) AS dentro_sla
FROM public.cards c
WHERE c.cod_ultima_ocorrencia = 21
  AND c.responsavel_relacionamento IS NOT NULL
  AND c.state NOT IN ('RESOLVIDO', 'CANCELADO')
  AND NOT EXISTS (
    SELECT 1 FROM historico_eventos h
    WHERE h.card_id = c.id
      AND h.codigo <> 21
      AND h.data_evento > COALESCE(
        (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
        c.updated_at - interval '1 day'
      )
  )
ORDER BY dias_uteis_parados DESC NULLS LAST;

GRANT SELECT ON public.v_oc21_paradas_prioridades TO authenticated, service_role;

-- v_oc13_paradas — adiciona tipo_cte
CREATE VIEW public.v_oc13_paradas
WITH (security_invoker = on) AS
WITH historico_eventos AS (
  SELECT
    c.id AS card_id,
    (h.elem->>'codigo')::int AS codigo,
    (
      '20' || split_part(split_part(h.elem->>'data', ' ', 1), '/', 3) || '-' ||
      lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 2), 2, '0') || '-' ||
      lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 1), 2, '0') || ' ' ||
      split_part(h.elem->>'data', ' ', 2) || ':00-03'
    )::timestamptz AS data_evento
  FROM public.cards c
  CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) AS h(elem)
  WHERE c.historico_ssw IS NOT NULL
    AND (h.elem->>'codigo')::int IS NOT NULL
    AND (h.elem->>'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
)
SELECT
  c.id AS card_id,
  c.nf,
  c.ctrc,
  c.tipo_cte,
  c.responsavel_relacionamento,
  c.base_destino,
  c.pagador AS pagador_nome,
  c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
  c.empresa_cliente,
  c.nome_cliente,
  c.state,
  c.assigned_operator_id,
  COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at - interval '1 day'
  ) AS data_oc13,
  ROUND(EXTRACT(EPOCH FROM (now() - COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at
  ))) / 60)::int AS minutos_paradas,
  ROUND(EXTRACT(EPOCH FROM (now() - COALESCE(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    c.updated_at
  ))) / 3600, 1) AS horas_paradas,
  ROUND(public.dias_uteis_entre(
    COALESCE(
      (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
      c.updated_at
    ), now()
  ), 2) AS dias_uteis_parados,
  (public.dias_uteis_entre(
    COALESCE(
      (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
      c.updated_at
    ), now()
  ) <= 1) AS dentro_sla
FROM public.cards c
WHERE c.cod_ultima_ocorrencia = 13
  AND c.responsavel_relacionamento IS NOT NULL
  AND c.state NOT IN ('RESOLVIDO', 'CANCELADO')
  AND NOT EXISTS (
    SELECT 1 FROM historico_eventos h
    WHERE h.card_id = c.id
      AND h.codigo <> 13
      AND h.data_evento > COALESCE(
        (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
        c.updated_at - interval '1 day'
      )
  )
ORDER BY dias_uteis_parados DESC NULLS LAST;

GRANT SELECT ON public.v_oc13_paradas TO authenticated, service_role;

-- v_prioridades_ai — propaga tipo_cte
CREATE VIEW public.v_prioridades_ai
WITH (security_invoker = on) AS
WITH paradas AS (
  SELECT
    card_id, nf, ctrc, tipo_cte, base_destino AS base, responsavel_relacionamento,
    pagador_nome, cnpj_pagador, empresa_cliente,
    data_oc21 AS data_oc_referencia,
    minutos_paradas, horas_paradas, dias_uteis_parados, dentro_sla,
    21 AS oc_origem
  FROM public.v_oc21_paradas_prioridades

  UNION ALL

  SELECT
    card_id, nf, ctrc, tipo_cte, base_destino AS base, responsavel_relacionamento,
    pagador_nome, cnpj_pagador, empresa_cliente,
    data_oc13 AS data_oc_referencia,
    minutos_paradas, horas_paradas, dias_uteis_parados, dentro_sla,
    13 AS oc_origem
  FROM public.v_oc13_paradas
),
ult_analise AS (
  SELECT DISTINCT ON (card_id)
    card_id, tipo, rank_priorizador, observacao_priorizador,
    veredito_monitor, proxima_acao_monitor, analisado_em
  FROM public.analises_prioridades_ai
  WHERE expira_em > now()
  ORDER BY card_id, analisado_em DESC
),
ult_cobranca AS (
  SELECT DISTINCT ON (card_id)
    card_id, papel, canal, disparado_em
  FROM public.cobrancas_disparadas
  ORDER BY card_id, disparado_em DESC
)
SELECT
  p.card_id,
  p.nf,
  p.ctrc,
  p.tipo_cte,
  p.base,
  p.responsavel_relacionamento,
  p.pagador_nome,
  p.cnpj_pagador,
  p.empresa_cliente,
  p.data_oc_referencia,
  p.minutos_paradas,
  p.horas_paradas,
  p.dias_uteis_parados,
  p.dentro_sla,
  p.oc_origem,
  c.state AS card_state,
  c.assigned_operator_id,
  c.pagador,
  c.segmento_codigo,
  c.prioridades_kanban_status AS coluna_kanban,
  CASE
    WHEN ua.card_id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'tipo', ua.tipo,
      'rank_priorizador', ua.rank_priorizador,
      'observacao_priorizador', ua.observacao_priorizador,
      'veredito_monitor', ua.veredito_monitor,
      'proxima_acao_monitor', ua.proxima_acao_monitor,
      'analisado_em', ua.analisado_em
    )
  END AS ia_insight,
  CASE
    WHEN uc.card_id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'papel', uc.papel,
      'canal', uc.canal,
      'disparado_em', uc.disparado_em
    )
  END AS ult_cobranca,
  EXISTS (
    SELECT 1 FROM public.cobrancas_disparadas
    WHERE card_id = p.card_id AND papel = 'gerente_base'
  ) AS ja_cobrou_gerente_base,
  EXISTS (
    SELECT 1 FROM public.cobrancas_disparadas
    WHERE card_id = p.card_id AND papel = 'coordenador_entrega'
  ) AS ja_cobrou_coordenador,
  EXISTS (
    SELECT 1 FROM public.cobrancas_disparadas
    WHERE card_id = p.card_id AND papel = 'gerente_relacionamento'
  ) AS ja_cobrou_gerente_rel
FROM paradas p
JOIN public.cards c ON c.id = p.card_id
LEFT JOIN ult_analise ua ON ua.card_id = p.card_id
LEFT JOIN ult_cobranca uc ON uc.card_id = p.card_id;

GRANT SELECT ON public.v_prioridades_ai TO authenticated, service_role;

COMMENT ON VIEW public.v_prioridades_ai IS
  'Caio 2026-05-19 v3: kanban PRIORIDADES AI. UNION oc=21 + oc=13. Inclui '
  'tipo_cte (NORMAL/REVERSA/etc) e coluna_kanban (cards.prioridades_kanban_status). '
  'security_invoker=on.';
