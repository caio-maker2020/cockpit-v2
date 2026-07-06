-- =============================================================================
-- Agente autônomo de extravios (PART 2) — M3: auditoria por operador + track-record
--
-- Caio 2026-06-24: toda ação do agente (lançou 49 / não rodou / recomendou /
-- reportado errado) precisa aparecer na aba AUDITORIA, SEPARADA por operador
-- (operador vê só os cards dele). As ações já viram card_events; aqui crio:
--   - v_agente_extravio_auditoria: lista de ações do agente (narrada), por card.
--   - v_agente_extravio_metricas: track-record por operador (= o "contador de
--     acertos": lançadas / não-rodou / reportadas-erradas). NÃO é gate automático.
--   - RPC reportar_erro_agente_extravio: operador/Caio marca "agente errou aqui".
--   - FIX RLS de cards_auditoria (estava authenticated USING(true) → vazava).
--
-- Isolamento por operador = security_invoker nas views (respeita RLS de card_events,
-- que já filtra por card_visivel_pelo_operador_atual). Ver INV (M5).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. FIX RLS de cards_auditoria — operador vê só snapshots dos cards dele.
--    (estava `USING (true)` — qualquer authenticated via tudo.)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS cards_auditoria_select_auth ON public.cards_auditoria;
DROP POLICY IF EXISTS cards_auditoria_select_operador ON public.cards_auditoria;
CREATE POLICY cards_auditoria_select_operador
  ON public.cards_auditoria
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = cards_auditoria.card_id_original
        AND public.card_visivel_pelo_operador_atual(c.assigned_operator_id, c.pagador, c.segmento_codigo)
    )
  );

-- ----------------------------------------------------------------------------
-- 2. v_agente_extravio_auditoria — lista narrada das ações do agente (por card).
--    security_invoker → RLS de card_events (operador vê só os cards dele).
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_agente_extravio_auditoria;
CREATE VIEW public.v_agente_extravio_auditoria
WITH (security_invoker = on) AS
SELECT
  ce.id AS event_id,
  ce.card_id,
  c.nf,
  c.assigned_operator_id,
  c.responsavel_relacionamento AS operador,
  ce.event_type,
  CASE ce.event_type
    WHEN 'AgenteExtravioLancou49'        THEN 'Agente lançou a oc 49 (PRAZO DE PERDAS EXPIRADO) automaticamente'
    WHEN 'AgenteExtravioRecomendou'      THEN 'Agente conferiu o SSW e recomendou lançar a oc 49 (aguardando validação)'
    WHEN 'AgenteExtravioNaoRodou'        THEN 'Agente NÃO rodou — ' || COALESCE(ce.payload->>'motivo', 'achou ocorrência pós-extravio no SSW')
    WHEN 'AgenteExtravioReportadoErrado' THEN 'Reportado como ERRO do agente — ' || COALESCE(ce.payload->>'motivo', '(sem detalhe)')
  END AS descricao,
  (ce.payload->>'oc_achada')::int   AS oc_achada,
  ce.payload,
  ce.created_at
FROM public.card_events ce
JOIN public.cards c ON c.id = ce.card_id
WHERE ce.event_type IN (
  'AgenteExtravioLancou49', 'AgenteExtravioRecomendou',
  'AgenteExtravioNaoRodou', 'AgenteExtravioReportadoErrado'
)
ORDER BY ce.created_at DESC;

GRANT SELECT ON public.v_agente_extravio_auditoria TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. v_agente_extravio_metricas — track-record por operador (o "contador").
--    Visível por operador (security_invoker → só os cards dele); gestor vê todos.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_agente_extravio_metricas;
CREATE VIEW public.v_agente_extravio_metricas
WITH (security_invoker = on) AS
SELECT
  c.responsavel_relacionamento AS operador,
  count(*) FILTER (WHERE ce.event_type = 'AgenteExtravioLancou49')        AS lancadas,
  count(*) FILTER (WHERE ce.event_type = 'AgenteExtravioNaoRodou')        AS nao_rodou,
  count(*) FILTER (WHERE ce.event_type = 'AgenteExtravioReportadoErrado') AS reportadas_erradas,
  max(ce.created_at) AS ultima_acao
FROM public.card_events ce
JOIN public.cards c ON c.id = ce.card_id
WHERE ce.event_type IN (
  'AgenteExtravioLancou49', 'AgenteExtravioNaoRodou', 'AgenteExtravioReportadoErrado'
)
GROUP BY c.responsavel_relacionamento
ORDER BY lancadas DESC NULLS LAST;

GRANT SELECT ON public.v_agente_extravio_metricas TO authenticated, service_role;

COMMENT ON VIEW public.v_agente_extravio_metricas IS
  'Track-record do agente de extravio por operador (lançadas/não-rodou/reportadas-erradas). '
  'NÃO é gate automático de autonomia — só visibilidade. O gate de ligar o autônomo é a '
  'validação por lote do Caio (flag extravios_agente_autonomo_enabled). Caio 2026-06-24.';

-- ----------------------------------------------------------------------------
-- 4. RPC reportar_erro_agente_extravio — operador/Caio marca "agente errou aqui".
--    Vira card_event AgenteExtravioReportadoErrado (entra na contagem de erradas).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reportar_erro_agente_extravio(
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
    p_card_id, 'AgenteExtravioReportadoErrado', 'operator', v_user::text,
    jsonb_build_object(
      'motivo', NULLIF(trim(COALESCE(p_motivo, '')), ''),
      'reportado_por', COALESCE(v_nome, 'desconhecido')
    )
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reportar_erro_agente_extravio(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reportar_erro_agente_extravio(uuid, text) TO authenticated, service_role;
