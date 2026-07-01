-- =============================================================================
-- Agente ressarc54 — auditoria credita TODO lançamento da 54 pelo Cockpit
--
-- Caio 2026-06-25: a auditoria só mostrava "lançou" quando o AGENTE autônomo
-- lançava. Quando o operador clicava "aprovar" na sugestão (lançamento manual pelo
-- Cockpit), a 54 ia pro SSW mas não aparecia como lançada na auditoria. A
-- reconciliação (edge) agora emite RessarcRelancar54Lancou com payload.por_operador
-- pros cards recomendados cuja 54 foi relançada pelo Cockpit. Aqui:
--   1. a timeline distingue "lançou (operador)" de "lançou (agente autônomo)";
--   2. as métricas contam CARDS DISTINTOS (dedupe de re-scans) + separam autônomo
--      x operador.
-- =============================================================================

DROP VIEW IF EXISTS public.v_ressarc54_auditoria;
CREATE VIEW public.v_ressarc54_auditoria
WITH (security_invoker = on) AS
SELECT
  ce.id AS event_id,
  ce.card_id,
  c.nf,
  c.assigned_operator_id,
  c.responsavel_relacionamento AS operador,
  ce.event_type,
  (ce.payload->>'tier') AS tier,
  (ce.payload->>'por_operador')::boolean AS por_operador,
  CASE ce.event_type
    WHEN 'RessarcRelancar54Recomendou' THEN 'Agente detectou round-trip de ressarcimento e recomendou RELANÇAR só a oc 54 (tier ' || COALESCE(ce.payload->>'tier','?') || ')'
    WHEN 'RessarcRelancar54Lancou' THEN
      CASE WHEN (ce.payload->>'por_operador')::boolean IS TRUE
        THEN 'Operador aprovou e o Cockpit RELANÇOU a oc 54 (seguindo a sugestão do agente, tier ' || COALESCE(ce.payload->>'tier','?') || ')'
        ELSE 'Agente RELANÇOU a oc 54 automaticamente (round-trip de ressarcimento, tier ' || COALESCE(ce.payload->>'tier','?') || ')'
      END
    WHEN 'RessarcRelancar54NaoRodou' THEN 'Agente NÃO rodou — ' || COALESCE(ce.payload->>'motivo', 'não confirmou o padrão')
    WHEN 'RessarcRelancar54ReportadoErrado' THEN 'Reportado como ERRO do agente — ' || COALESCE(ce.payload->>'motivo', '(sem detalhe)')
  END AS descricao,
  ce.payload,
  ce.created_at
FROM public.card_events ce
JOIN public.cards c ON c.id = ce.card_id
WHERE ce.event_type IN (
  'RessarcRelancar54Recomendou', 'RessarcRelancar54Lancou',
  'RessarcRelancar54NaoRodou',   'RessarcRelancar54ReportadoErrado'
)
ORDER BY ce.created_at DESC;

GRANT SELECT ON public.v_ressarc54_auditoria TO authenticated, service_role;

-- Métricas por CARD DISTINTO (re-scan não infla a contagem) + autônomo x operador.
DROP VIEW IF EXISTS public.v_ressarc54_metricas;
CREATE VIEW public.v_ressarc54_metricas
WITH (security_invoker = on) AS
SELECT
  c.responsavel_relacionamento AS operador,
  count(DISTINCT ce.card_id) FILTER (WHERE ce.event_type = 'RessarcRelancar54Recomendou')                              AS recomendadas,
  count(DISTINCT ce.card_id) FILTER (WHERE ce.event_type = 'RessarcRelancar54Lancou')                                  AS lancadas,
  count(DISTINCT ce.card_id) FILTER (WHERE ce.event_type = 'RessarcRelancar54Lancou' AND (ce.payload->>'por_operador')::boolean IS NOT TRUE) AS lancadas_autonomo,
  count(DISTINCT ce.card_id) FILTER (WHERE ce.event_type = 'RessarcRelancar54Lancou' AND (ce.payload->>'por_operador')::boolean IS TRUE)     AS lancadas_operador,
  count(DISTINCT ce.card_id) FILTER (WHERE ce.event_type = 'RessarcRelancar54NaoRodou')                                AS nao_rodou,
  count(DISTINCT ce.card_id) FILTER (WHERE ce.event_type = 'RessarcRelancar54ReportadoErrado')                         AS reportadas_erradas,
  max(ce.created_at) AS ultima_acao
FROM public.card_events ce
JOIN public.cards c ON c.id = ce.card_id
WHERE ce.event_type IN (
  'RessarcRelancar54Recomendou', 'RessarcRelancar54Lancou',
  'RessarcRelancar54NaoRodou',   'RessarcRelancar54ReportadoErrado'
)
GROUP BY c.responsavel_relacionamento
ORDER BY lancadas DESC NULLS LAST;

GRANT SELECT ON public.v_ressarc54_metricas TO authenticated, service_role;

COMMENT ON VIEW public.v_ressarc54_metricas IS
  'Track-record do agente ressarc54 por operador, por CARD DISTINTO: recomendadas, '
  'lancadas (autônomo + operador), nao_rodou, reportadas_erradas. NÃO é gate automático.';
