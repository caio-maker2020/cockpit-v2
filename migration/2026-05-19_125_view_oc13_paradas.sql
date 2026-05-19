-- ============================================================================
-- Cockpit v2 — v_oc13_paradas (PRIORIDADES AI MVP)
-- Data: 2026-05-19
--
-- Análoga a v_oc21_aguardando_oc14 mas pra cards com última oc=13 sem
-- movimentação. Diferenças vs oc=21:
--
-- 1. Data de referência: cards.bastao_data_ultima_ocorrencia (oc=13 vem do
--    Bastão; raramente é lançada via Cockpit). Fallback: card_events recente
--    de 'BastaoCardImportado' / 'BastaoCardAtualizado' com cod=13.
--
-- 2. Filtro de state: NOT IN (RESOLVIDO, CANCELADO).
--    TRANSFERIDO incluído SOMENTE quando cnpj_pagador ∈ cliente_config_oc13
--    (mig 121) — esses 12 CNPJs são exceção: oc=13 com card mantido no
--    Cockpit pra cobrança. Outros TRANSFERIDOS já saíram da carteira.
--
-- 3. "Pendente" = sem oc nova posterior (qualquer oc diferente de 13)
--    no historico_ssw. Movimentação típica de saída: oc=14 ou finalizadora.
--    Mas qualquer oc não-13 indica que algo aconteceu → tira da view.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_oc13_paradas
WITH (security_invoker = on) AS
WITH oc13_data AS (
  -- Data da oc=13 atual: usa bastao_data_ultima_ocorrencia se cod_ultima=13
  SELECT
    c.id AS card_id,
    COALESCE(
      (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
      c.updated_at - interval '1 day'  -- fallback se data NULL (raro)
    ) AS data_oc13
  FROM public.cards c
  WHERE c.cod_ultima_ocorrencia = 13
),
historico_eventos AS (
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
),
exc_cnpjs AS (
  SELECT cnpj_pagador FROM public.cliente_config_oc13 WHERE ativo
),
pendentes AS (
  SELECT
    o13.card_id,
    c.nf,
    c.ctrc,
    c.responsavel_relacionamento,
    c.base_destino,
    c.pagador AS pagador_nome,
    c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
    c.empresa_cliente,
    c.nome_cliente,
    c.state,
    c.assigned_operator_id,
    o13.data_oc13,
    ROUND(EXTRACT(EPOCH FROM (now() - o13.data_oc13)) / 60)::int AS minutos_paradas,
    ROUND(EXTRACT(EPOCH FROM (now() - o13.data_oc13)) / 3600, 1) AS horas_paradas,
    ROUND(public.dias_uteis_entre(o13.data_oc13, now()), 2) AS dias_uteis_parados,
    (public.dias_uteis_entre(o13.data_oc13, now()) <= 1) AS dentro_sla
  FROM oc13_data o13
  JOIN public.cards c ON c.id = o13.card_id
  WHERE c.responsavel_relacionamento IS NOT NULL
    AND (
      -- State ativo: card ainda em tratativa
      c.state NOT IN ('TRANSFERIDO', 'RESOLVIDO', 'CANCELADO')
      OR (
        -- Exceção: TRANSFERIDO incluído se cnpj_pagador ∈ cliente_config_oc13
        c.state = 'TRANSFERIDO'
        AND (c.agent_state->>'cnpj_pagador') IN (SELECT cnpj_pagador FROM exc_cnpjs)
      )
    )
    -- Sem oc nova posterior à oc=13 (qualquer oc diferente indica movimento)
    AND NOT EXISTS (
      SELECT 1 FROM historico_eventos h
      WHERE h.card_id = o13.card_id
        AND h.codigo <> 13
        AND h.data_evento > o13.data_oc13
    )
)
SELECT
  p.*,
  CASE
    WHEN p.dentro_sla THEN 'aguardando_dentro_sla'
    ELSE 'fora_sla'
  END AS status_visual
FROM pendentes p
ORDER BY p.minutos_paradas DESC;

GRANT SELECT ON public.v_oc13_paradas TO authenticated, service_role;

COMMENT ON VIEW public.v_oc13_paradas IS
  'Caio 2026-05-19: cards com última oc=13 sem movimentação posterior. '
  'State NÃO IN (RESOLVIDO, CANCELADO). TRANSFERIDO incluído só se cnpj_pagador '
  'está em cliente_config_oc13 (12 CNPJs excepcionais). Source: '
  'bastao_data_ultima_ocorrencia + historico_ssw. dias_uteis_parados via '
  'dias_uteis_entre(). SLA=1 dia útil. security_invoker=on (RLS de cards).';
