-- =============================================================================
-- painel_capacidade AO VIVO (Caio 2026-06-23) — os medidores "atual" passam a ser
-- CALCULADOS na hora de cada chamada (a página busca a cada 60s), em vez de ler o
-- último snapshot de 10min. Resultado: gauges com no máx ~1min de atraso.
-- O histórico/tendência (48h) e os picos seguem vindo dos snapshots de 10min
-- (granularidade certa pra trend); o alerta do health-check segue lendo o último
-- snapshot (10min basta pra "aja agora"). HTML não muda (já lê esses campos).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.painel_capacidade(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_conn_total int; v_conn_max int; v_oper int; v_jobs int;
  v_runs int; v_timeouts int; v_pct numeric; v_tpct numeric;
  v_sp text; v_sr text; v_result jsonb;
BEGIN
  IF p_token IS DISTINCT FROM 'salexcap7f3k9q2x' THEN
    RAISE EXCEPTION 'token invalido';
  END IF;

  -- AO VIVO: recalcula a cada chamada (não lê o último snapshot).
  SELECT count(*) INTO v_conn_total FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database();
  v_conn_max := pg_catalog.current_setting('max_connections')::int;
  SELECT count(*) INTO v_oper FROM public.operadores WHERE ativo;
  SELECT count(*) INTO v_jobs FROM cron.job WHERE active;
  SELECT count(*) INTO v_runs FROM cron.job_run_details WHERE start_time > now() - interval '24 hours';
  SELECT count(*) INTO v_timeouts FROM cron.job_run_details
    WHERE start_time > now() - interval '24 hours' AND status = 'failed' AND return_message ILIKE '%startup%';
  v_pct  := round(100.0 * v_conn_total / NULLIF(v_conn_max, 0), 1);
  v_tpct := coalesce(round(100.0 * v_timeouts / NULLIF(v_runs, 0), 1), 0);
  v_sp := CASE WHEN v_pct  >= 80 THEN 'vermelho' WHEN v_pct  >= 60 THEN 'amarelo' ELSE 'verde' END;
  v_sr := CASE WHEN v_tpct >= 5  THEN 'vermelho' WHEN v_tpct >  0  THEN 'amarelo' ELSE 'verde' END;

  SELECT jsonb_build_object(
    'gerado_em', now(),
    'ao_vivo', true,
    'atual', jsonb_build_object(
      'ts', now(), 'conn_total', v_conn_total, 'conn_max', v_conn_max, 'conn_pct', v_pct,
      'operadores_ativos', v_oper, 'cron_jobs_ativos', v_jobs, 'cron_runs_24h', v_runs,
      'cron_startup_timeouts_24h', v_timeouts, 'cron_timeout_pct', v_tpct,
      'status_pessoas', v_sp, 'status_robos', v_sr),
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
