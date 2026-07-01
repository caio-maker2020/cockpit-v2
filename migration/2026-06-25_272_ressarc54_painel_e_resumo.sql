-- =============================================================================
-- Agente ressarc54 — painel (card a card, filtrável) + resumo (números no topo)
--
-- Caio 2026-06-25: quero ENTENDER COM NÚMEROS o agente relançar-54: tudo que foi
-- lançado efetivo (autônomo + operador) e tudo que sugeriu, com filtro LANÇOU /
-- RECOMENDOU / NÃO RODOU. Estas views são CARD-A-CARD (não event-a-event), então
-- não inflam com re-scans. "nao_aplica" (padrão não bate) NÃO entra — só os cards
-- em que o agente agiu.
-- =============================================================================

-- 1. PAINEL — uma linha por card que o agente tocou (recomendou/lançou/não rodou).
--    O front filtra pelas flags foi_recomendado / foi_lancado / teve_nao_rodou
--    (um card lançado conta TAMBÉM como recomendado — é o funil).
DROP VIEW IF EXISTS public.v_ressarc54_painel;
CREATE VIEW public.v_ressarc54_painel
WITH (security_invoker = on) AS
WITH ev AS (
  SELECT
    ce.card_id,
    bool_or(ce.event_type = 'RessarcRelancar54Recomendou')                                              AS foi_recomendado,
    bool_or(ce.event_type = 'RessarcRelancar54Lancou')                                                  AS foi_lancado,
    bool_or(ce.event_type = 'RessarcRelancar54Lancou' AND (ce.payload->>'por_operador')::boolean IS TRUE)     AS lancado_por_operador,
    bool_or(ce.event_type = 'RessarcRelancar54Lancou' AND (ce.payload->>'por_operador')::boolean IS NOT TRUE) AS lancado_autonomo,
    bool_or(ce.event_type = 'RessarcRelancar54NaoRodou')                                                AS teve_nao_rodou,
    bool_or(ce.event_type = 'RessarcRelancar54ReportadoErrado')                                          AS reportado_errado,
    max(ce.payload->>'tier') FILTER (WHERE ce.payload->>'tier' IS NOT NULL)                             AS tier,
    max(ce.created_at)                                                                                  AS ultima_acao,
    max(ce.created_at) FILTER (WHERE ce.event_type = 'RessarcRelancar54Lancou')                         AS lancado_em
  FROM public.card_events ce
  WHERE ce.event_type LIKE 'RessarcRelancar54%'
  GROUP BY ce.card_id
)
SELECT
  ev.card_id,
  c.nf,
  c.responsavel_relacionamento AS operador,
  c.assigned_operator_id,
  ev.tier,
  -- Recomendação só é VIGENTE se o card ainda está no escopo do agente: não foi
  -- lançado, está em AVH/AGUARDANDO_CLIENTE e ainda na oc 49. Card transferido ou
  -- que moveu de oc = recomendação stale (não conta como RECOMENDOU ativo).
  (NOT ev.foi_lancado
     AND c.state IN ('AGUARDANDO_VALIDACAO_HUMANA','AGUARDANDO_CLIENTE')
     AND c.cod_ultima_ocorrencia = 49) AS vigente,
  -- categoria primária (mutuamente exclusiva).
  CASE
    WHEN ev.foi_lancado THEN 'LANCOU'
    WHEN NOT (c.state IN ('AGUARDANDO_VALIDACAO_HUMANA','AGUARDANDO_CLIENTE') AND c.cod_ultima_ocorrencia = 49)
      THEN 'SAIU_DE_ESCOPO'
    WHEN ev.foi_recomendado THEN 'RECOMENDOU'
    ELSE 'NAO_RODOU'
  END AS categoria,
  CASE WHEN ev.lancado_por_operador THEN 'operador'
       WHEN ev.lancado_autonomo     THEN 'autonomo' END AS lancado_por,
  ev.foi_recomendado,
  ev.foi_lancado,
  ev.teve_nao_rodou,
  ev.reportado_errado,
  c.state,
  c.cod_ultima_ocorrencia,
  (c.aviso_alteracao_oc->>'oc49_instrucao') AS instrucao_49,
  ev.lancado_em,
  ev.ultima_acao
FROM ev
JOIN public.cards c ON c.id = ev.card_id;

GRANT SELECT ON public.v_ressarc54_painel TO authenticated, service_role;

COMMENT ON VIEW public.v_ressarc54_painel IS
  'Painel card-a-card do agente ressarc54. Filtro do front: LANÇOU=foi_lancado, '
  'RECOMENDOU=foi_recomendado (inclui lançados=funil), NÃO RODOU=teve_nao_rodou AND NOT foi_lancado. '
  'categoria = status primário mutuamente exclusivo. Caio 2026-06-25.';

-- 2. RESUMO — números no topo do painel (global; security_invoker respeita RLS).
DROP VIEW IF EXISTS public.v_ressarc54_resumo;
CREATE VIEW public.v_ressarc54_resumo
WITH (security_invoker = on) AS
SELECT
  count(*) FILTER (WHERE foi_recomendado)                                  AS sugeriu_total,
  count(*) FILTER (WHERE foi_recomendado AND tier = 'A')                   AS sugeriu_tier_a,
  count(*) FILTER (WHERE foi_recomendado AND tier = 'B')                   AS sugeriu_tier_b,
  count(*) FILTER (WHERE foi_lancado)                                      AS lancou_total,
  count(*) FILTER (WHERE lancado_por = 'autonomo')                         AS lancou_autonomo,
  count(*) FILTER (WHERE lancado_por = 'operador')                         AS lancou_operador,
  count(*) FILTER (WHERE NOT foi_lancado AND teve_nao_rodou)               AS nao_rodou_total,
  count(*) FILTER (WHERE NOT foi_lancado AND foi_recomendado)              AS recomendou_pendente,
  count(*) FILTER (WHERE reportado_errado)                                 AS reportado_errado_total
FROM public.v_ressarc54_painel;

GRANT SELECT ON public.v_ressarc54_resumo TO authenticated, service_role;

COMMENT ON VIEW public.v_ressarc54_resumo IS
  'Números do topo do painel ressarc54: sugeriu (A/B), lançou (autônomo/operador), '
  'não rodou, recomendou pendente, reportado errado. Caio 2026-06-25.';
