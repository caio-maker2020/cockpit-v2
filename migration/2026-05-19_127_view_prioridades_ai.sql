-- ============================================================================
-- Cockpit v2 — v_prioridades_ai (kanban PRIORIDADES AI)
-- Data: 2026-05-19
--
-- View unificada UNION oc=21 + oc=13. Cada row tem:
--   - dados base (NF, CTRC, base, dias parados, responsável, oc origem)
--   - coluna_kanban (cards.prioridades_kanban_status — fonte verdade visual)
--   - última análise IA (jsonb) — Priorizador OR Monitor
--   - última cobrança (jsonb)
--   - flags ja_cobrou_X (UX dos botões)
--
-- Ordenação default: dias_uteis_parados DESC, mas o front aplica rank
-- do Priorizador quando disponível.
--
-- security_invoker=on garante RLS de cards aplicado.
-- ============================================================================

DROP VIEW IF EXISTS public.v_prioridades_ai;

CREATE VIEW public.v_prioridades_ai
WITH (security_invoker = on) AS
WITH paradas AS (
  -- oc=21 paradas
  SELECT
    card_id, nf, ctrc, base_destino AS base, responsavel_relacionamento,
    pagador_nome, cnpj_pagador, empresa_cliente,
    data_oc21 AS data_oc_referencia,
    minutos_paradas, horas_paradas, dias_uteis_parados, dentro_sla,
    21 AS oc_origem
  FROM public.v_oc21_aguardando_oc14

  UNION ALL

  -- oc=13 paradas
  SELECT
    card_id, nf, ctrc, base_destino AS base, responsavel_relacionamento,
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
  -- IA insight (jsonb pra front desestruturar)
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
  -- Última cobrança (jsonb)
  CASE
    WHEN uc.card_id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'papel', uc.papel,
      'canal', uc.canal,
      'disparado_em', uc.disparado_em
    )
  END AS ult_cobranca,
  -- Flags pra UX dos botões (sem precisar de N subqueries no front)
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
  'Kanban PRIORIDADES AI. UNION oc=21 + oc=13 paradas. coluna_kanban vem '
  'de cards.prioridades_kanban_status (cacheado). ia_insight = última '
  'análise não-expirada (Priorizador OU Monitor). security_invoker=on.';
