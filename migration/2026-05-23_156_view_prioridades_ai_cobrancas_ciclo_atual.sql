-- ============================================================================
-- Cockpit v2 — v_prioridades_ai: cobranças contam só do CICLO ATUAL
-- Caio 2026-05-23
--
-- REGRA (Caio): "se o ciclo recomeça, a cobrança recomeça". Ou seja, quando
-- uma nova oc=21 (ou oc=13) é lançada após oc=14/10/etc, abre NOVO CICLO:
--   - dias úteis parados reiniciam (a partir da oc=21/13 nova)
--   - cobranças PASSADAS (do ciclo anterior) NÃO devem contar
--   - card volta pra coluna 'parada' (sem cobrança nesse ciclo)
--   - IA insight pode citar cobranças do ciclo anterior como contexto
--
-- Caso âncora NF 1492103:
--   - oc=21 antiga: 19/05 10:22
--   - cobrança coord 20/05 15:29 + 21/05 11:58
--   - oc=14, oc=10, oc=21 NOVA em 21/05 13:35 (recomeça ciclo)
--   - cobranças ant. ficam no histórico, mas pra esse ciclo: 0 cobranças
--   - kanban correto: 'parada' (com IA mostrando "ciclo anterior cobrou coord 2x")
--
-- FIX:
--   - flags ja_cobrou_*: filtrar por disparado_em > data_anchora
--   - coluna_kanban: COMPUTADO dinâmico, não cacheado
--   - cobrancas_ciclo_atual_total + cobrancas_ciclos_anteriores: pra IA
-- ============================================================================

DROP VIEW IF EXISTS public.v_prioridades_ai CASCADE;

CREATE VIEW public.v_prioridades_ai
WITH (security_invoker = on) AS
WITH paradas AS (
  SELECT card_id, nf, ctrc, tipo_cte, responsavel_relacionamento, base_destino,
         cidade_destino, uf_destino,
         pagador_nome, cnpj_pagador, empresa_cliente, nome_cliente,
         state, assigned_operator_id, data_oc21 AS data_anchora,
         minutos_paradas, horas_paradas, dias_uteis_parados, dentro_sla,
         21 AS oc_origem
  FROM public.v_oc21_paradas_prioridades
  UNION ALL
  SELECT card_id, nf, ctrc, tipo_cte, responsavel_relacionamento, base_destino,
         cidade_destino, uf_destino,
         pagador_nome, cnpj_pagador, empresa_cliente, nome_cliente,
         state, assigned_operator_id, data_oc13 AS data_anchora,
         minutos_paradas, horas_paradas, dias_uteis_parados, dentro_sla,
         13 AS oc_origem
  FROM public.v_oc13_paradas_prioridades
)
SELECT
  p.*,
  c.pagador,

  -- Última análise IA (priorizador ou monitor) — alimenta pílula no card
  (SELECT jsonb_build_object('tipo', a.tipo, 'rank_priorizador', a.rank_priorizador,
      'observacao_priorizador', a.observacao_priorizador, 'veredito_monitor', a.veredito_monitor,
      'proxima_acao_monitor', a.proxima_acao_monitor, 'analisado_em', a.analisado_em)
     FROM public.analises_prioridades_ai a WHERE a.card_id = p.card_id
     ORDER BY a.analisado_em DESC LIMIT 1) AS ia_insight,

  -- Última cobrança (qualquer ciclo) — pra display "última atividade"
  (SELECT jsonb_build_object('papel', cb.papel, 'canal', cb.canal, 'em', cb.disparado_em)
     FROM public.cobrancas_disparadas cb WHERE cb.card_id = p.card_id
     ORDER BY cb.disparado_em DESC LIMIT 1) AS ult_cobranca,

  -- FLAGS DO CICLO ATUAL — só cobranças posteriores à oc=21/13 mais recente.
  -- Ciclo anterior NÃO conta.
  EXISTS (SELECT 1 FROM public.cobrancas_disparadas
          WHERE card_id=p.card_id AND papel='coordenador_entrega'
            AND status='enviado' AND disparado_em > p.data_anchora) AS ja_cobrou_coordenador,
  EXISTS (SELECT 1 FROM public.cobrancas_disparadas
          WHERE card_id=p.card_id AND papel='gerente_base'
            AND status='enviado' AND disparado_em > p.data_anchora) AS ja_cobrou_gerente_base,
  EXISTS (SELECT 1 FROM public.cobrancas_disparadas
          WHERE card_id=p.card_id AND papel='gerente_relacionamento'
            AND status='enviado' AND disparado_em > p.data_anchora) AS ja_cobrou_gerente_rel,

  -- COBRANÇAS DO CICLO ATUAL (lista detalhada — pra modal/tooltip)
  (SELECT count(*)::int FROM public.cobrancas_disparadas
   WHERE card_id=p.card_id AND status='enviado' AND disparado_em > p.data_anchora)
    AS cobrancas_ciclo_atual_total,

  -- COBRANÇAS DE CICLOS ANTERIORES (contexto pra IA + transparência)
  (SELECT count(*)::int FROM public.cobrancas_disparadas
   WHERE card_id=p.card_id AND status='enviado' AND disparado_em <= p.data_anchora)
    AS cobrancas_ciclos_anteriores_total,

  -- LISTA detalhada dos ciclos anteriores (jsonb) — pra IA reconhecer histórico
  (SELECT COALESCE(jsonb_agg(
      jsonb_build_object('papel', cb.papel, 'canal', cb.canal, 'em', cb.disparado_em)
      ORDER BY cb.disparado_em DESC), '[]'::jsonb)
   FROM public.cobrancas_disparadas cb
   WHERE cb.card_id=p.card_id AND cb.status='enviado' AND cb.disparado_em <= p.data_anchora
   LIMIT 10) AS cobrancas_ciclos_anteriores_lista,

  -- COLUNA KANBAN COMPUTADA dinamicamente (não usa cache cards.prioridades_kanban_status)
  -- Regra: cobranças do CICLO ATUAL determinam coluna. Resolvido só vem do
  -- agente-monitor (não derivado aqui).
  CASE
    WHEN c.prioridades_kanban_status = 'resolvido' THEN 'resolvido'
    WHEN EXISTS (SELECT 1 FROM public.cobrancas_disparadas
                 WHERE card_id=p.card_id AND papel='gerente_relacionamento'
                   AND status='enviado' AND disparado_em > p.data_anchora)
      THEN 'escalado_gerencia_interna'
    WHEN EXISTS (SELECT 1 FROM public.cobrancas_disparadas
                 WHERE card_id=p.card_id AND papel='gerente_base'
                   AND status='enviado' AND disparado_em > p.data_anchora)
      THEN 'escalado'
    WHEN EXISTS (SELECT 1 FROM public.cobrancas_disparadas
                 WHERE card_id=p.card_id AND papel='coordenador_entrega'
                   AND status='enviado' AND disparado_em > p.data_anchora)
      THEN 'cobrado'
    ELSE 'parada'
  END AS coluna_kanban

FROM paradas p
JOIN public.cards c ON c.id = p.card_id;

GRANT SELECT ON public.v_prioridades_ai TO authenticated, service_role;

COMMENT ON VIEW public.v_prioridades_ai IS
  'v6 Caio 2026-05-23: coluna_kanban + ja_cobrou_* computados dinâmicos por '
  'CICLO ATUAL (cobranças > data_anchora). Ciclo recomeça quando oc=21/13 '
  'nova. Cobranças anteriores ficam em cobrancas_ciclos_anteriores_* pra IA.';
