-- =============================================================================
-- painel_capacidade: + VOLUME de automações executadas, hoje e por dia
-- (Caio 2026-06-24). Noção de quanto os robôs trabalharam.
--   automacoes_executadas_hoje / automacoes_falhas_hoje = headline do dia (BRT).
--   execucoes_por_dia = últimos 7 dias (BRT), cada um {dia, executadas, falhas}.
-- "de fato executadas" = status='succeeded' (exclui as que nem iniciaram).
-- Fonte: cron.job_run_details (retém 7 dias — cleanup_cron_logs(7)). Dia em BRT.
-- Mantém tudo da mig 245 (status pela janela recente); só ACRESCENTA campos.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.painel_capacidade(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_conn_total int; v_conn_max int; v_oper int; v_jobs int;
  v_runs24 int; v_to24 int; v_to1h int; v_runs1h int;
  v_inicio_dia timestamptz; v_exec_hoje int; v_fail_hoje int;
  v_pct numeric; v_tpct numeric; v_sp text; v_sr text; v_result jsonb;
BEGIN
  IF p_token IS DISTINCT FROM 'salexcap7f3k9q2x' THEN
    RAISE EXCEPTION 'token invalido';
  END IF;

  SELECT count(*) INTO v_conn_total FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database();
  v_conn_max := pg_catalog.current_setting('max_connections')::int;
  SELECT count(*) INTO v_oper FROM public.operadores WHERE ativo;
  SELECT count(*) INTO v_jobs FROM cron.job WHERE active;
  SELECT count(*) INTO v_runs24 FROM cron.job_run_details WHERE start_time > now() - interval '24 hours';
  SELECT count(*) INTO v_to24  FROM cron.job_run_details
    WHERE start_time > now() - interval '24 hours' AND status='failed' AND return_message ILIKE '%startup%';
  SELECT count(*) INTO v_runs1h FROM cron.job_run_details WHERE start_time > now() - interval '1 hour';
  SELECT count(*) INTO v_to1h  FROM cron.job_run_details
    WHERE start_time > now() - interval '1 hour' AND status='failed' AND return_message ILIKE '%startup%';

  -- volume executado HOJE (dia civil de Brasília)
  v_inicio_dia := date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  SELECT count(*) FILTER (WHERE status='succeeded'), count(*) FILTER (WHERE status='failed')
    INTO v_exec_hoje, v_fail_hoje
  FROM cron.job_run_details WHERE start_time >= v_inicio_dia;

  v_pct  := round(100.0 * v_conn_total / NULLIF(v_conn_max, 0), 1);
  v_tpct := coalesce(round(100.0 * v_to1h / NULLIF(v_runs1h, 0), 1), 0);
  v_sp := CASE WHEN v_pct >= 80 THEN 'vermelho' WHEN v_pct >= 60 THEN 'amarelo' ELSE 'verde' END;
  v_sr := CASE WHEN v_to1h >= 20 THEN 'vermelho' WHEN v_to1h >= 5 THEN 'amarelo' ELSE 'verde' END;

  SELECT jsonb_build_object(
    'gerado_em', now(),
    'ao_vivo', true,
    'atual', jsonb_build_object(
      'ts', now(), 'conn_total', v_conn_total, 'conn_max', v_conn_max, 'conn_pct', v_pct,
      'operadores_ativos', v_oper, 'cron_jobs_ativos', v_jobs, 'cron_runs_24h', v_runs24,
      'cron_startup_timeouts_24h', v_to24, 'cron_timeouts_1h', v_to1h, 'cron_timeout_pct', v_tpct,
      'automacoes_executadas_hoje', v_exec_hoje, 'automacoes_falhas_hoje', v_fail_hoje,
      'status_pessoas', v_sp, 'status_robos', v_sr),
    'execucoes_por_dia', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
                'dia', dia, 'executadas', exec, 'falhas', fail) ORDER BY dia DESC), '[]'::jsonb)
      FROM (
        SELECT (start_time AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
               count(*) FILTER (WHERE status='succeeded') AS exec,
               count(*) FILTER (WHERE status='failed')    AS fail
        FROM cron.job_run_details
        WHERE start_time >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - interval '6 days') AT TIME ZONE 'America/Sao_Paulo'
        GROUP BY 1
      ) d),
    'pico_conn_pct_24h', (SELECT max(conn_pct) FROM public.capacity_snapshots WHERE ts > now() - interval '24 hours'),
    'pico_conn_pct_7d',  (SELECT max(conn_pct) FROM public.capacity_snapshots WHERE ts > now() - interval '7 days'),
    'max_oper_7d',       (SELECT max(operadores_ativos) FROM public.capacity_snapshots WHERE ts > now() - interval '7 days'),
    'max_jobs_7d',       (SELECT max(cron_jobs_ativos) FROM public.capacity_snapshots WHERE ts > now() - interval '7 days'),
    'historico', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
                'ts', ts, 'conn_pct', conn_pct, 'cron_timeout_pct', cron_timeout_pct,
                'operadores', operadores_ativos, 'jobs', cron_jobs_ativos) ORDER BY ts), '[]'::jsonb)
      FROM public.capacity_snapshots WHERE ts > now() - interval '48 hours')
  ) INTO v_result;
  RETURN v_result;
END $$;
