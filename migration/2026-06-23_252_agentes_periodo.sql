-- =============================================================================
-- Leaderboard de AGENTES (Caio 2026-06-24) — quem mais trabalha / aciona.
--
-- Fonte: card_events (decisões reais de cada agente) + agent_runs (triador, que
-- classifica toda mensagem mas não tem evento próprio em card_events). card_events
-- é permanente → histórico ilimitado. "trabalho" = decisão/ação tomada (NÃO os
-- skips/no-ops do tipo *Falhou, que são o agente acordando e não tendo o que fazer).
--
-- Mapa agente → evento (fácil ajustar):
--   propositor-acoes        = TodoPropostoAutomaticamente
--   triador                 = agent_runs (agent_name='triador')
--   sugere-ocs-padrao       = AgenteOcsPadraoDecisao
--   interpretador-evidencia = EvidenciaSugestaoIA
--   interpretador-resposta  = InterpretadorRespostaClienteConcluido
--   agente-oc13             = AgenteOc13Decisao
-- =============================================================================

CREATE OR REPLACE FUNCTION public.agentes_periodo(p_token text, p_inicio date, p_fim date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v jsonb; v_ini timestamptz; v_fim timestamptz;
BEGIN
  IF p_token IS DISTINCT FROM 'salexcap7f3k9q2x' THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  v_ini := p_inicio::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_fim := (p_fim + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';

  WITH base AS (
    SELECT CASE event_type
             WHEN 'AgenteOcsPadraoDecisao'                 THEN 'sugere-ocs-padrao'
             WHEN 'AgenteOc13Decisao'                      THEN 'agente-oc13'
             WHEN 'InterpretadorRespostaClienteConcluido'  THEN 'interpretador-resposta'
             WHEN 'EvidenciaSugestaoIA'                    THEN 'interpretador-evidencia'
             WHEN 'TodoPropostoAutomaticamente'            THEN 'propositor-acoes'
           END AS slug,
           count(*) AS acoes
    FROM public.card_events
    WHERE created_at >= v_ini AND created_at < v_fim
      AND event_type IN ('AgenteOcsPadraoDecisao','AgenteOc13Decisao',
                         'InterpretadorRespostaClienteConcluido','EvidenciaSugestaoIA',
                         'TodoPropostoAutomaticamente')
    GROUP BY 1
    UNION ALL
    SELECT 'triador', count(*)
    FROM public.agent_runs
    WHERE agent_name = 'triador' AND started_at >= v_ini AND started_at < v_fim
  ),
  rotulado AS (
    SELECT slug, acoes,
      CASE slug
        WHEN 'triador'                 THEN 'Triador — classifica toda mensagem que chega (e-mail/WhatsApp)'
        WHEN 'propositor-acoes'        THEN 'Propositor — cria as ações sugeridas (to-dos) automaticamente'
        WHEN 'sugere-ocs-padrao'       THEN 'Sugestor ocs-padrão — decide 54/56 em extravio/avaria (oc 10/11/19/35)'
        WHEN 'interpretador-resposta'  THEN 'Interpretador de resposta — lê a resposta do cliente e sugere o passo'
        WHEN 'interpretador-evidencia' THEN 'Interpretador de evidência — lê a foto da ocorrência (visão)'
        WHEN 'agente-oc13'             THEN 'Agente oc13 — lança oc autônoma para clientes-exceção'
      END AS descricao
    FROM base WHERE acoes > 0
  )
  SELECT jsonb_build_object(
    'inicio', p_inicio, 'fim', p_fim,
    'total', coalesce(sum(acoes), 0),
    'agentes', coalesce(jsonb_agg(jsonb_build_object(
                 'agente', slug, 'descricao', descricao, 'acoes', acoes) ORDER BY acoes DESC), '[]'::jsonb)
  ) INTO v FROM rotulado;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.agentes_periodo(text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agentes_periodo(text, date, date) TO anon, authenticated;
