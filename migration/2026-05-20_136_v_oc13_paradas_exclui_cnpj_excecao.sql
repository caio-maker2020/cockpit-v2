-- =============================================================================
-- v_oc13_paradas: excluir CNPJs em cliente_config_oc13
--
-- Caio 2026-05-20: regra de exceção oc=13 (memory project_cliente_config_oc13).
--
-- Pra CNPJs nos 12 registros de cliente_config_oc13, oc=13 vira card no INBOX
-- (state=AGUARDANDO_VOCE) — Larissa trata propostas (21/54/56/41) ali.
-- Esses cards NÃO devem duplicar em PRIORIDADES AI.
-- Pra clientes não-exceção, oc=13 nem cria card (operação trata sem Cockpit).
--
-- Efeito líquido: v_oc13_paradas fica praticamente vazia. Mantida pra cobrir
-- casos residuais (cards legacy com oc=13 sem exceção) e auditoria.
--
-- v_oc21_paradas_prioridades: SEM mudança. oc=21 sempre aparece pra todos
-- (lançamento indevido ou aprovação Larissa), regra do Caio:
-- "se a larissa aprovar a 21 lá no cockpit automaticamente ela tem q entrar".
--
-- Idempotente (CREATE OR REPLACE), security_invoker preservado.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_oc13_paradas
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
  c.base_destino,
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
  -- Caio 2026-05-20: CNPJs em cliente_config_oc13 são tratados no INBOX,
  -- NÃO em PRIORIDADES AI. Excluir aqui evita duplicação.
  AND NOT EXISTS (
    SELECT 1 FROM public.cliente_config_oc13 e
    WHERE e.cnpj_pagador = (c.agent_state ->> 'cnpj_pagador')
      AND e.ativo
  )
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

COMMENT ON VIEW public.v_oc13_paradas IS
  'Cards parados em oc=13. Caio 2026-05-20: exclui CNPJs em cliente_config_oc13 '
  '(esses vão pro INBOX). Pra clientes não-exceção, oc=13 nem cria card.';
