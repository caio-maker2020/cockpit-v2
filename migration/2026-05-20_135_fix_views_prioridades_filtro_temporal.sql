-- =============================================================================
-- v_oc13_paradas + v_oc21_paradas_prioridades: fix filtro temporal
--
-- Caio 2026-05-20: 30+ NFs (Duilio+Larissa) sumiam de PRIORIDADES AI por bug:
--
--   ANTES: comparava `historico_evento.data_evento > bastao_data_ultima_ocorrencia`
--          mas `bastao_data_ultima_ocorrencia` é DATE (= meia-noite TZ -03).
--          Qualquer evento do mesmo dia DEPOIS da meia-noite era lido como
--          "posterior", excluindo o card erroneamente.
--          Ex: card NF 2296843, bastao_date=2026-05-18, evento oc=54 em
--          18/05 17:09 → excluído mesmo a oc=21 atual sendo de 20/05 15:24.
--
--   AGORA: filtro compara com o timestamp do EVENTO da oc atual no próprio
--          histórico SSW. Excluir card só se houver evento POSTERIOR à última
--          ocorrência (13 ou 21) lançada no histórico SSW.
--          Fallback: se histórico SSW ainda não tem a oc atual (lançada via
--          Cockpit, sync pendente), usa NULL → não exclui.
--
-- Cobre cenário pedido pelo Caio:
--   - Entrada: Bastão sinaliza oc 13/21 (cod_ultima_ocorrencia atualizado pelo
--     sync) OU operador lança 13/21 dentro do Cockpit (executor atualiza
--     cod_ultima_ocorrencia + grava evento no historico_ssw)
--   - Permanência: enquanto não houver evento POSTERIOR à última oc=13/21 no
--     histórico SSW. Eventos antigos (oc=14 entregue antes de re-lançar 21)
--     não excluem.
--   - Saída: assim que SSW lança oc=14 (entregue) ou outra finalizadora depois
--     da oc=13/21 atual, card some.
--
-- Idempotente. Não usa CASCADE — preserva v_prioridades_ai (depende destas).
-- security_invoker=on mantido (RLS do operador respeitada).
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
  AND NOT EXISTS (
    SELECT 1
    FROM historico_eventos h
    LEFT JOIN ultima_oc_atual u ON u.card_id = h.card_id
    WHERE h.card_id = c.id
      AND h.codigo <> 13
      -- Só exclui se houver evento POSTERIOR à última oc=13 no histórico.
      -- Se card ainda não tem oc=13 no histórico (sync pendente), u.ts_atual
      -- é NULL → comparação NULL → não exclui (correto: aparece no kanban).
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


COMMENT ON VIEW public.v_oc13_paradas IS
  'Cards parados em oc=13. Critério de exclusão: existe evento POSTERIOR à '
  'última oc=13 no histórico SSW com código diferente (= SSW já avançou). '
  'Caio 2026-05-20: substituiu comparação com bastao_data (DATE) que tinha '
  'bug de truncate de timestamp e excluía falsos positivos.';

COMMENT ON VIEW public.v_oc21_paradas_prioridades IS
  'Cards parados em oc=21 (reentrega solicitada). Mesma lógica do v_oc13_paradas.';
