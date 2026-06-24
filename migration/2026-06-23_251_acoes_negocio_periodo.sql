-- =============================================================================
-- Ações de NEGÓCIO por dia (Caio 2026-06-24) — trabalho real do sistema, não o
-- heartbeat dos robôs. Pra ver "estamos usando cada vez mais": cresce com o uso.
--
-- Fonte: card_events (event sourcing, NUNCA apagado → histórico ilimitado, sem
-- rollup). Índice idx_card_events_type_created. Dia em BRT. Buckets:
--   ocs lançadas     = AcaoExecutada / AcaoExecutadaPortal               (count eventos)
--   e-mails enviados = RespostaEnviada / RespostaManualEnviadaPeloCockpit(count eventos)
--   cards resolvidos = CardResolvidoBastaoFimDePendencia                 (count eventos)
--   cards transferidos = state_novo='TRANSFERIDO' (saída p/ outro setor) (count DISTINCT card)
--     — distinct card_id porque vários eventos (AcaoExecutadaConfirmadaPeloSsw,
--       AtualizadoViaPortalSsw) marcam o MESMO transfer; sem distinct duplicaria.
-- (pra ajustar um bucket, é só editar a lista de event_type / o filtro aqui.)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.acoes_negocio_periodo(p_token text, p_inicio date, p_fim date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v jsonb; v_ini timestamptz; v_fim timestamptz;
BEGIN
  IF p_token IS DISTINCT FROM 'salexcap7f3k9q2x' THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  v_ini := p_inicio::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_fim := (p_fim + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';  -- limite superior exclusivo

  WITH d AS (
    SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
      count(*) FILTER (WHERE event_type IN ('AcaoExecutada','AcaoExecutadaPortal'))                AS ocs,
      count(*) FILTER (WHERE event_type IN ('RespostaEnviada','RespostaManualEnviadaPeloCockpit')) AS emails,
      count(*) FILTER (WHERE event_type = 'CardResolvidoBastaoFimDePendencia')                     AS resolvidos,
      count(DISTINCT card_id) FILTER (WHERE payload->>'state_novo' = 'TRANSFERIDO')                AS transferidos
    FROM public.card_events
    WHERE created_at >= v_ini AND created_at < v_fim
      AND event_type IN ('AcaoExecutada','AcaoExecutadaPortal','RespostaEnviada',
                         'RespostaManualEnviadaPeloCockpit','CardResolvidoBastaoFimDePendencia',
                         'AcaoExecutadaConfirmadaPeloSsw','AtualizadoViaPortalSsw','DevolvidoParaSetor')
    GROUP BY 1
  )
  SELECT jsonb_build_object(
    'inicio', p_inicio, 'fim', p_fim,
    'total_ocs',          coalesce(sum(ocs), 0),
    'total_emails',       coalesce(sum(emails), 0),
    'total_resolvidos',   coalesce(sum(resolvidos), 0),
    'total_transferidos', coalesce(sum(transferidos), 0),
    'total_geral',        coalesce(sum(ocs + emails + resolvidos + transferidos), 0),
    'dias_com_dado',      count(*),
    'media_dia',          coalesce(round(avg(ocs + emails + resolvidos + transferidos))::int, 0),
    'dias', coalesce(jsonb_agg(jsonb_build_object(
              'dia', dia, 'ocs', ocs, 'emails', emails, 'resolvidos', resolvidos, 'transferidos', transferidos,
              'total', ocs + emails + resolvidos + transferidos) ORDER BY dia), '[]'::jsonb)
  ) INTO v FROM d;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.acoes_negocio_periodo(text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acoes_negocio_periodo(text, date, date) TO anon, authenticated;
