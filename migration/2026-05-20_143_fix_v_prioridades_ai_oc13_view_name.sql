-- ============================================================================
-- Cockpit v2 — v_prioridades_ai aponta pra v_oc13_paradas_prioridades
-- Caio 2026-05-20
--
-- Bug NF 142083 (OVD): card aparecia no kanban PRIORIDADES AI mas modal
-- "Cobrança escalonada" retornava "card não está em v_prioridades_ai".
-- Causa: v_prioridades_ai fazia UNION com v_oc13_paradas (view antiga, mig 125),
-- mas a view ativa é v_oc13_paradas_prioridades (atualizada mig 135 + 139).
-- A view antiga não cobria todos os cards (44 vs 45) — específicamente os
-- com cnpj_pagador em cliente_config_oc13 com filtro temporal diferente.
--
-- Fix: re-CREATE v_prioridades_ai trocando FROM v_oc13_paradas → 
-- FROM v_oc13_paradas_prioridades. security_invoker=on preservado.
-- ============================================================================

DROP VIEW IF EXISTS public.v_prioridades_ai;

CREATE VIEW public.v_prioridades_ai
WITH (security_invoker = on) AS
 WITH paradas AS (
         SELECT v_oc21_paradas_prioridades.card_id,
            v_oc21_paradas_prioridades.nf,
            v_oc21_paradas_prioridades.ctrc,
            v_oc21_paradas_prioridades.tipo_cte,
            v_oc21_paradas_prioridades.base_destino AS base,
            v_oc21_paradas_prioridades.responsavel_relacionamento,
            v_oc21_paradas_prioridades.pagador_nome,
            v_oc21_paradas_prioridades.cnpj_pagador,
            v_oc21_paradas_prioridades.empresa_cliente,
            v_oc21_paradas_prioridades.data_oc21 AS data_oc_referencia,
            v_oc21_paradas_prioridades.minutos_paradas,
            v_oc21_paradas_prioridades.horas_paradas,
            v_oc21_paradas_prioridades.dias_uteis_parados,
            v_oc21_paradas_prioridades.dentro_sla,
            21 AS oc_origem
           FROM v_oc21_paradas_prioridades
        UNION ALL
         SELECT v_oc13_paradas_prioridades.card_id,
            v_oc13_paradas_prioridades.nf,
            v_oc13_paradas_prioridades.ctrc,
            v_oc13_paradas_prioridades.tipo_cte,
            v_oc13_paradas_prioridades.base_destino AS base,
            v_oc13_paradas_prioridades.responsavel_relacionamento,
            v_oc13_paradas_prioridades.pagador_nome,
            v_oc13_paradas_prioridades.cnpj_pagador,
            v_oc13_paradas_prioridades.empresa_cliente,
            v_oc13_paradas_prioridades.data_oc13 AS data_oc_referencia,
            v_oc13_paradas_prioridades.minutos_paradas,
            v_oc13_paradas_prioridades.horas_paradas,
            v_oc13_paradas_prioridades.dias_uteis_parados,
            v_oc13_paradas_prioridades.dentro_sla,
            13 AS oc_origem
           FROM v_oc13_paradas_prioridades
        ), ult_analise AS (
         SELECT DISTINCT ON (analises_prioridades_ai.card_id) analises_prioridades_ai.card_id,
            analises_prioridades_ai.tipo,
            analises_prioridades_ai.rank_priorizador,
            analises_prioridades_ai.observacao_priorizador,
            analises_prioridades_ai.veredito_monitor,
            analises_prioridades_ai.proxima_acao_monitor,
            analises_prioridades_ai.analisado_em
           FROM analises_prioridades_ai
          WHERE analises_prioridades_ai.expira_em > now()
          ORDER BY analises_prioridades_ai.card_id, analises_prioridades_ai.analisado_em DESC
        ), ult_cobranca AS (
         SELECT DISTINCT ON (cobrancas_disparadas.card_id) cobrancas_disparadas.card_id,
            cobrancas_disparadas.papel,
            cobrancas_disparadas.canal,
            cobrancas_disparadas.disparado_em
           FROM cobrancas_disparadas
          ORDER BY cobrancas_disparadas.card_id, cobrancas_disparadas.disparado_em DESC
        )
 SELECT p.card_id,
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
            WHEN ua.card_id IS NULL THEN NULL::jsonb
            ELSE jsonb_build_object('tipo', ua.tipo, 'rank_priorizador', ua.rank_priorizador, 'observacao_priorizador', ua.observacao_priorizador, 'veredito_monitor', ua.veredito_monitor, 'proxima_acao_monitor', ua.proxima_acao_monitor, 'analisado_em', ua.analisado_em)
        END AS ia_insight,
        CASE
            WHEN uc.card_id IS NULL THEN NULL::jsonb
            ELSE jsonb_build_object('papel', uc.papel, 'canal', uc.canal, 'disparado_em', uc.disparado_em)
        END AS ult_cobranca,
    (EXISTS ( SELECT 1
           FROM cobrancas_disparadas
          WHERE cobrancas_disparadas.card_id = p.card_id AND cobrancas_disparadas.papel = 'gerente_base'::text)) AS ja_cobrou_gerente_base,
    (EXISTS ( SELECT 1
           FROM cobrancas_disparadas
          WHERE cobrancas_disparadas.card_id = p.card_id AND cobrancas_disparadas.papel = 'coordenador_entrega'::text)) AS ja_cobrou_coordenador,
    (EXISTS ( SELECT 1
           FROM cobrancas_disparadas
          WHERE cobrancas_disparadas.card_id = p.card_id AND cobrancas_disparadas.papel = 'gerente_relacionamento'::text)) AS ja_cobrou_gerente_rel
   FROM paradas p
     JOIN cards c ON c.id = p.card_id
     LEFT JOIN ult_analise ua ON ua.card_id = p.card_id
     LEFT JOIN ult_cobranca uc ON uc.card_id = p.card_id;;
