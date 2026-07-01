-- =============================================================================
-- Agente "relançar 54 por ressarcimento" (M2) — auditoria + taxa de acertos
--
-- Caio 2026-06-25: toda ação do agente (recomendou / relançou 54 / não rodou /
-- reportado errado) vira card_event e precisa aparecer SEPARADA por operador na
-- aba AUDITORIA (operador vê só os cards dele = security_invoker respeita RLS de
-- card_events). Espelha mig 258 (agente-extravio-d4):
--   - v_ressarc54_auditoria: ações narradas por card (o que Caio confere 1 a 1).
--   - v_ressarc54_metricas : track-record por operador (o "contador de acertos").
--   - RPC reportar_erro_ressarc54: operador/Caio marca "agente errou aqui".
-- O gate de ligar o autônomo NÃO é automático — é a validação manual do Caio +
-- a flag ressarcimento_relancar54_autonomo_enabled (mig 268).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. v_ressarc54_auditoria — lista narrada das ações do agente (por card).
-- ----------------------------------------------------------------------------
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
  CASE ce.event_type
    WHEN 'RessarcRelancar54Recomendou'      THEN 'Agente detectou round-trip de ressarcimento e recomendou RELANÇAR só a oc 54 (tier ' || COALESCE(ce.payload->>'tier','?') || ')'
    WHEN 'RessarcRelancar54Lancou'          THEN 'Agente RELANÇOU a oc 54 automaticamente (round-trip de ressarcimento, tier ' || COALESCE(ce.payload->>'tier','?') || ')'
    WHEN 'RessarcRelancar54NaoRodou'        THEN 'Agente NÃO rodou — ' || COALESCE(ce.payload->>'motivo', 'não confirmou o padrão')
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

-- ----------------------------------------------------------------------------
-- 2. v_ressarc54_metricas — track-record por operador (o "contador de acertos").
--    Quebrado por tier pra Caio separar a confiança do determinístico (A) do
--    interpretado (B). NÃO é gate automático — só visibilidade.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_ressarc54_metricas;
CREATE VIEW public.v_ressarc54_metricas
WITH (security_invoker = on) AS
SELECT
  c.responsavel_relacionamento AS operador,
  count(*) FILTER (WHERE ce.event_type = 'RessarcRelancar54Recomendou')                                 AS recomendadas,
  count(*) FILTER (WHERE ce.event_type = 'RessarcRelancar54Recomendou' AND ce.payload->>'tier' = 'A')   AS recomendadas_tier_a,
  count(*) FILTER (WHERE ce.event_type = 'RessarcRelancar54Recomendou' AND ce.payload->>'tier' = 'B')   AS recomendadas_tier_b,
  count(*) FILTER (WHERE ce.event_type = 'RessarcRelancar54Lancou')                                      AS lancadas,
  count(*) FILTER (WHERE ce.event_type = 'RessarcRelancar54NaoRodou')                                    AS nao_rodou,
  count(*) FILTER (WHERE ce.event_type = 'RessarcRelancar54ReportadoErrado')                             AS reportadas_erradas,
  max(ce.created_at) AS ultima_acao
FROM public.card_events ce
JOIN public.cards c ON c.id = ce.card_id
WHERE ce.event_type IN (
  'RessarcRelancar54Recomendou', 'RessarcRelancar54Lancou',
  'RessarcRelancar54NaoRodou',   'RessarcRelancar54ReportadoErrado'
)
GROUP BY c.responsavel_relacionamento
ORDER BY recomendadas DESC NULLS LAST;

GRANT SELECT ON public.v_ressarc54_metricas TO authenticated, service_role;

COMMENT ON VIEW public.v_ressarc54_metricas IS
  'Track-record do agente relançar-54-por-ressarcimento por operador (recomendadas A/B, '
  'lançadas, não-rodou, reportadas-erradas). NÃO é gate automático de autonomia — só '
  'visibilidade. Gate = validação manual do Caio + flag ressarcimento_relancar54_autonomo_enabled.';

-- ----------------------------------------------------------------------------
-- 3. RPC reportar_erro_ressarc54 — operador/Caio marca "agente errou aqui".
--    Vira card_event RessarcRelancar54ReportadoErrado (entra na contagem).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reportar_erro_ressarc54(
  p_card_id uuid,
  p_motivo  text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_nome text;
  v_id   uuid;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT nome INTO v_nome FROM public.operadores WHERE user_id = v_user LIMIT 1;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'RessarcRelancar54ReportadoErrado', 'operator', v_user::text,
    jsonb_build_object(
      'motivo', NULLIF(trim(COALESCE(p_motivo, '')), ''),
      'reportado_por', COALESCE(v_nome, 'desconhecido')
    )
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reportar_erro_ressarc54(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reportar_erro_ressarc54(uuid, text) TO authenticated, service_role;
