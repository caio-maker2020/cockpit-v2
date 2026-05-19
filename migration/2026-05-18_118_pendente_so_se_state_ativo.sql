-- ============================================================================
-- Cockpit v2 — Pendente vs Finalizada usa state do card como fonte de verdade
-- Data: 2026-05-18
--
-- Bug: NFs 351849 / 692021 (e várias) apareciam como pendentes mesmo após o
-- card sair da carteira (state=TRANSFERIDO). Causa raiz: historico_ssw estava
-- vazio nesses cards (cron de 6h ainda não rodou ou falhou), e a view v3 só
-- olhava o histórico pra decidir se já tinha oc=14 / finalizadora.
--
-- Decisão Caio 2026-05-18: "pendente é apenas oq nao está finalizado". Cards
-- em state TRANSFERIDO/RESOLVIDO/CANCELADO já saíram da carteira do operador
-- — finalizados, ponto. O sync-bastao + Pass H já cuidam de validar que a
-- saída foi legítima (oc=14 ou finalizadora confirmada via SSW interno).
--
-- Mudanças:
--   1. v_oc21_aguardando_oc14: filtra c.state NOT IN ('TRANSFERIDO','RESOLVIDO','CANCELADO')
--   2. v_oc21_finalizadas: UNION dos cards que finalizaram via histórico OU via state.
--      Pra cards fechados via state sem evidência no histórico: data_fechamento =
--      cards.updated_at, tipo_fechamento = 'inferido_state_<state>'.
-- ============================================================================

-- ----- v_oc21_aguardando_oc14 v4: só PENDENTES de fato ---------------------

DROP VIEW IF EXISTS public.v_oc21_aguardando_oc14 CASCADE;

CREATE VIEW public.v_oc21_aguardando_oc14
WITH (security_invoker = on) AS
WITH oc21_aprovacoes AS (
  SELECT
    ce.card_id,
    MAX(ce.created_at) AS data_oc21
  FROM public.card_events ce
  WHERE ce.event_type = 'AcaoExecutada'
    AND ce.payload->>'codigo_ssw' = '21'
    AND ce.payload->>'sucesso' = 'true'
    AND ce.created_at > now() - interval '60 days'
  GROUP BY ce.card_id
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
    AND (h.elem->>'codigo')::int IN (1, 14, 30, 32)
    AND (h.elem->>'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
),
pendentes AS (
  SELECT
    o21.card_id,
    c.nf,
    c.ctrc,
    c.responsavel_relacionamento,
    c.base_destino,
    c.pagador AS pagador_nome,
    c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
    c.empresa_cliente,
    c.nome_cliente,
    o21.data_oc21,
    ROUND(EXTRACT(EPOCH FROM (now() - o21.data_oc21)) / 60)::int AS minutos_paradas,
    ROUND(EXTRACT(EPOCH FROM (now() - o21.data_oc21)) / 3600, 1) AS horas_paradas,
    ROUND(public.dias_uteis_entre(o21.data_oc21, now()), 2) AS dias_uteis_parados,
    (public.dias_uteis_entre(o21.data_oc21, now()) <= 1) AS dentro_sla
  FROM oc21_aprovacoes o21
  JOIN public.cards c ON c.id = o21.card_id
  WHERE c.responsavel_relacionamento IS NOT NULL
    AND c.ctrc IS NOT NULL
    -- Caio 2026-05-18: card só é pendente se está em state ativo de relacionamento.
    -- TRANSFERIDO/RESOLVIDO/CANCELADO já saíram da carteira => finalizado.
    AND c.state NOT IN ('TRANSFERIDO', 'RESOLVIDO', 'CANCELADO')
    AND NOT EXISTS (
      SELECT 1 FROM historico_eventos h
      WHERE h.card_id = o21.card_id
        AND h.codigo = 14
        AND h.data_evento > o21.data_oc21
    )
    AND NOT EXISTS (
      SELECT 1 FROM historico_eventos h
      WHERE h.card_id = o21.card_id
        AND h.codigo IN (1, 30, 32)
        AND h.data_evento > o21.data_oc21
    )
)
SELECT
  p.*,
  NULL::text AS filial_oc21,
  NULL::text AS usuario_oc21,
  a.id AS alerta_id,
  a.status AS alerta_status,
  a.base_oc14_esperada AS alerta_base_destino,
  a.destinatario_email AS alerta_destinatario,
  a.enviado_em AS alerta_enviado_em,
  a.mensagem_assunto AS alerta_assunto,
  a.motivo_falha AS alerta_motivo_falha,
  CASE
    WHEN a.id IS NOT NULL AND a.status = 'enviado' THEN 'alerta_enviado'
    WHEN a.id IS NOT NULL AND a.status = 'falhou' THEN 'alerta_falhou'
    WHEN p.dentro_sla THEN 'aguardando_dentro_sla'
    ELSE 'fora_sla_sem_alerta'
  END AS status_visual
FROM pendentes p
LEFT JOIN public.alertas_sla_oc21_oc14 a
  ON a.card_id = p.card_id AND a.data_oc21 = p.data_oc21
ORDER BY p.minutos_paradas DESC;

GRANT SELECT ON public.v_oc21_aguardando_oc14 TO authenticated, service_role;

COMMENT ON VIEW public.v_oc21_aguardando_oc14 IS
  'Caio 2026-05-18 v4: PENDENTES = oc=21 lançada via Cockpit + state ainda '
  'ativo (NÃO TRANSFERIDO/RESOLVIDO/CANCELADO) + sem oc=14 e sem finalizadora '
  '(01/30/32) no historico_ssw. State é a fonte de verdade primária — cards '
  'fora da carteira nunca aparecem aqui, mesmo que historico_ssw esteja stale.';

-- ----- v_oc21_finalizadas v2: inclui fechamento via state ------------------

DROP VIEW IF EXISTS public.v_oc21_finalizadas CASCADE;

CREATE VIEW public.v_oc21_finalizadas
WITH (security_invoker = on) AS
WITH oc21_aprovacoes AS (
  SELECT
    ce.card_id,
    MAX(ce.created_at) AS data_oc21
  FROM public.card_events ce
  WHERE ce.event_type = 'AcaoExecutada'
    AND ce.payload->>'codigo_ssw' = '21'
    AND ce.payload->>'sucesso' = 'true'
    AND ce.created_at > now() - interval '90 days'
  GROUP BY ce.card_id
),
historico_eventos AS (
  SELECT
    c.id AS card_id,
    (h.elem->>'codigo')::int AS codigo,
    h.elem->>'filial' AS filial,
    h.elem->>'usuario' AS usuario,
    (
      '20' || split_part(split_part(h.elem->>'data', ' ', 1), '/', 3) || '-' ||
      lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 2), 2, '0') || '-' ||
      lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 1), 2, '0') || ' ' ||
      split_part(h.elem->>'data', ' ', 2) || ':00-03'
    )::timestamptz AS data_evento
  FROM public.cards c
  CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) AS h(elem)
  WHERE c.historico_ssw IS NOT NULL
    AND (h.elem->>'codigo')::int IN (1, 14, 30, 32)
    AND (h.elem->>'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
),
fechamento_via_historico AS (
  -- Caminho A: histórico SSW tem oc=14 ou finalizadora depois da 21
  SELECT DISTINCT ON (o21.card_id, o21.data_oc21)
    o21.card_id,
    o21.data_oc21,
    h.codigo AS codigo_fechamento,
    h.data_evento AS data_fechamento,
    h.filial AS base_fechamento,
    h.usuario AS usuario_fechamento,
    'historico_ssw'::text AS fonte_fechamento
  FROM oc21_aprovacoes o21
  JOIN historico_eventos h
    ON h.card_id = o21.card_id
   AND h.data_evento > o21.data_oc21
  ORDER BY o21.card_id, o21.data_oc21, h.data_evento ASC
),
fechamento_via_state AS (
  -- Caminho B: card em state final mas sem evidência no historico_ssw.
  -- Usa cards.updated_at como data de fechamento e marca a fonte.
  SELECT
    o21.card_id,
    o21.data_oc21,
    NULL::int AS codigo_fechamento,
    c.updated_at AS data_fechamento,
    c.base_destino AS base_fechamento,
    NULL::text AS usuario_fechamento,
    ('state_' || c.state)::text AS fonte_fechamento
  FROM oc21_aprovacoes o21
  JOIN public.cards c ON c.id = o21.card_id
  WHERE c.state IN ('TRANSFERIDO', 'RESOLVIDO', 'CANCELADO')
    AND NOT EXISTS (
      SELECT 1 FROM fechamento_via_historico fh
      WHERE fh.card_id = o21.card_id AND fh.data_oc21 = o21.data_oc21
    )
),
fechamentos AS (
  SELECT * FROM fechamento_via_historico
  UNION ALL
  SELECT * FROM fechamento_via_state
)
SELECT
  f.card_id,
  c.nf,
  c.ctrc,
  c.responsavel_relacionamento,
  c.base_destino,
  c.pagador AS pagador_nome,
  c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
  c.empresa_cliente,
  c.nome_cliente,
  c.state AS state_card,
  f.data_oc21,
  f.data_fechamento,
  f.codigo_fechamento,
  f.fonte_fechamento,
  CASE
    WHEN f.codigo_fechamento = 14 THEN 'oc14_saida'
    WHEN f.codigo_fechamento = 1  THEN 'oc01_entrega_realizada'
    WHEN f.codigo_fechamento = 30 THEN 'oc30_devolucao_comprovada'
    WHEN f.codigo_fechamento = 32 THEN 'oc32_entrega_nao_realizada'
    WHEN f.fonte_fechamento = 'state_TRANSFERIDO' THEN 'transferido_sem_evidencia'
    WHEN f.fonte_fechamento = 'state_RESOLVIDO'   THEN 'resolvido_sem_evidencia'
    WHEN f.fonte_fechamento = 'state_CANCELADO'   THEN 'cancelado_sem_evidencia'
    ELSE 'outro'
  END AS tipo_fechamento,
  f.base_fechamento,
  f.usuario_fechamento,
  ROUND(public.dias_uteis_entre(f.data_oc21, f.data_fechamento), 2) AS dias_uteis_para_fechar,
  ROUND(EXTRACT(EPOCH FROM (f.data_fechamento - f.data_oc21)) / 3600, 1) AS horas_para_fechar,
  (public.dias_uteis_entre(f.data_oc21, f.data_fechamento) <= 1) AS dentro_sla_dias_uteis
FROM fechamentos f
JOIN public.cards c ON c.id = f.card_id
WHERE c.responsavel_relacionamento IS NOT NULL
  AND c.ctrc IS NOT NULL
ORDER BY f.data_fechamento DESC;

GRANT SELECT ON public.v_oc21_finalizadas TO authenticated, service_role;

COMMENT ON VIEW public.v_oc21_finalizadas IS
  'Caio 2026-05-18 v2: ciclos oc=21 → fechamento. 2 caminhos: (A) histórico '
  'SSW tem oc=14/01/30/32 depois da 21; (B) card em state TRANSFERIDO/'
  'RESOLVIDO/CANCELADO sem evidência no histórico → usa updated_at. '
  'fonte_fechamento revela qual caminho. tipo_fechamento <X>_sem_evidencia '
  'sinaliza que histórico_ssw não foi puxado mas o sync já confirmou saída.';
