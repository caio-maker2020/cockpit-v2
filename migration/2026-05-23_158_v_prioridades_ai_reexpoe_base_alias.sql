-- ============================================================================
-- Cockpit v2 — v_prioridades_ai: re-expõe alias `base` (retrocompat callers)
-- Caio 2026-05-23
--
-- REGRESSÃO: mig 153 (e 155/156 que herdaram) recriaram v_prioridades_ai
-- selecionando `base_destino` direto, removendo o alias `base_destino AS base`
-- que existia nas mig 127/130/132/143. 3 edges quebraram silenciosamente:
--
--   listar-contatos-cobranca:
--     `select("base")` em v_prioridades_ai falha → fallback só globais →
--     dropdown só mostra Gerente de Relacionamento, esconde Gerente da Base
--     e Coordenador da base do card.
--
--   sugerir-cobranca-ai (linha 84):
--     monta `.or('base.eq.${prio.base ?? ""},base.is.null')` → quando
--     prio.base é undefined gera `base.eq.,base.is.null` → PostgREST rejeita
--     com 400 → catch retorna 500 → textarea fica vazia.
--
--   disparar-cobranca-escalonada (linha 188):
--     mesmo padrão `.or('base.ilike.${base ?? ""},base.is.null')` → mesmo
--     erro. Operador clica Enviar e modal mostra "non-2xx status code".
--
-- FIX MINIMO INVASIVO:
--   - Re-expor `base` como alias de `base_destino` na view final (não toca
--     o CTE `paradas`, não muda nada do schema das views base oc21/oc13).
--   - Callers que usam `.base` voltam a funcionar.
--   - Callers que usam `.base_destino` continuam funcionando (coluna mantida).
--
-- Estrutura preservada: mesma definição da mig 156 + um único acréscimo
-- (`p.base_destino AS base`). Reduz blast radius — não recria nada além
-- da view final.
--
-- skill: supabase-postgres-best-practices
--   * security_invoker=on (memory feedback_views_publicas_security_invoker)
--   * GRANT explícito a authenticated/service_role (memory feedback_rls_grant_antes_de_policy)
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
  -- ALIAS retrocompat: callers antigos (listar-contatos-cobranca,
  -- sugerir-cobranca-ai, disparar-cobranca-escalonada) leem `.base`.
  p.base_destino AS base,
  c.pagador,

  (SELECT jsonb_build_object('tipo', a.tipo, 'rank_priorizador', a.rank_priorizador,
      'observacao_priorizador', a.observacao_priorizador, 'veredito_monitor', a.veredito_monitor,
      'proxima_acao_monitor', a.proxima_acao_monitor, 'analisado_em', a.analisado_em)
     FROM public.analises_prioridades_ai a WHERE a.card_id = p.card_id
     ORDER BY a.analisado_em DESC LIMIT 1) AS ia_insight,

  (SELECT jsonb_build_object('papel', cb.papel, 'canal', cb.canal, 'em', cb.disparado_em)
     FROM public.cobrancas_disparadas cb WHERE cb.card_id = p.card_id
     ORDER BY cb.disparado_em DESC LIMIT 1) AS ult_cobranca,

  EXISTS (SELECT 1 FROM public.cobrancas_disparadas
          WHERE card_id=p.card_id AND papel='coordenador_entrega'
            AND status='enviado' AND disparado_em > p.data_anchora) AS ja_cobrou_coordenador,
  EXISTS (SELECT 1 FROM public.cobrancas_disparadas
          WHERE card_id=p.card_id AND papel='gerente_base'
            AND status='enviado' AND disparado_em > p.data_anchora) AS ja_cobrou_gerente_base,
  EXISTS (SELECT 1 FROM public.cobrancas_disparadas
          WHERE card_id=p.card_id AND papel='gerente_relacionamento'
            AND status='enviado' AND disparado_em > p.data_anchora) AS ja_cobrou_gerente_rel,

  (SELECT count(*)::int FROM public.cobrancas_disparadas
   WHERE card_id=p.card_id AND status='enviado' AND disparado_em > p.data_anchora)
    AS cobrancas_ciclo_atual_total,

  (SELECT count(*)::int FROM public.cobrancas_disparadas
   WHERE card_id=p.card_id AND status='enviado' AND disparado_em <= p.data_anchora)
    AS cobrancas_ciclos_anteriores_total,

  (SELECT COALESCE(jsonb_agg(
      jsonb_build_object('papel', cb.papel, 'canal', cb.canal, 'em', cb.disparado_em)
      ORDER BY cb.disparado_em DESC), '[]'::jsonb)
   FROM public.cobrancas_disparadas cb
   WHERE cb.card_id=p.card_id AND cb.status='enviado' AND cb.disparado_em <= p.data_anchora
   LIMIT 10) AS cobrancas_ciclos_anteriores_lista,

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
  'v7 Caio 2026-05-23: idêntica à v6 + re-expõe alias `base` (= base_destino) '
  'pra retrocompat dos 3 edges de cobrança escalonada que quebraram silenciosamente '
  'quando mig 153 dropou o alias.';
