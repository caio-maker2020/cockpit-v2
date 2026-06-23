-- =============================================================================
-- ROBÔS: semáforo pela JANELA RECENTE (última 1h), não 24h (Caio 2026-06-23).
--
-- PROBLEMA: o status dos robôs vinha de "% de startup timeout nas últimas 24h".
-- Um evento ÚNICO (o apagão de hoje, 14:30-15:15 BRT) deixava o semáforo AMARELO
-- por 24h inteiras — poluindo a leitura ("tenho que separar os robôs") mesmo sem
-- nenhuma falha nova. O sinal certo pra "separar os robôs" é "está faltando worker
-- AGORA?", não "faltou em algum momento do último dia".
--
-- FIX: status_robos passa a olhar a ÚLTIMA 1 HORA (contagem de startup timeouts):
--   verde 0-4 (tolera transiente raro de cold start — ver health-check 5/30min),
--   amarelo 5-19, vermelho >= 20. O número de 24h continua disponível como
--   CONTEXTO (cron_startup_timeouts_24h), e some sozinho da janela em 24h.
-- PESSOAS segue pela conexão ao vivo (não muda).
-- Atualiza as DUAS funções (snapshot + painel ao vivo) pra ficarem coerentes;
-- o alerta do health-check (lê status_robos do snapshot) passa a só disparar em
-- starvation RECENTE, não em resíduo velho.
-- =============================================================================

-- ---------- snapshot (cron 10min) ----------
CREATE OR REPLACE FUNCTION public.tirar_snapshot_capacidade()
RETURNS public.capacity_snapshots
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_conn_total int; v_conn_max int; v_oper int; v_jobs int;
  v_runs24 int; v_to24 int; v_to1h int; v_runs1h int;
  v_pct numeric; v_tpct numeric; v_sp text; v_sr text; v_row public.capacity_snapshots;
BEGIN
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

  v_pct  := round(100.0 * v_conn_total / NULLIF(v_conn_max, 0), 1);
  v_tpct := coalesce(round(100.0 * v_to1h / NULLIF(v_runs1h, 0), 1), 0);  -- % recente (1h)
  v_sp := CASE WHEN v_pct >= 80 THEN 'vermelho' WHEN v_pct >= 60 THEN 'amarelo' ELSE 'verde' END;
  v_sr := CASE WHEN v_to1h >= 20 THEN 'vermelho' WHEN v_to1h >= 5 THEN 'amarelo' ELSE 'verde' END;

  INSERT INTO public.capacity_snapshots
    (ts, conn_total, conn_max, conn_pct, operadores_ativos, cron_jobs_ativos,
     cron_runs_24h, cron_startup_timeouts_24h, cron_timeout_pct, status_pessoas, status_robos)
  VALUES
    (now(), v_conn_total, v_conn_max, v_pct, v_oper, v_jobs,
     v_runs24, v_to24, v_tpct, v_sp, v_sr)
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- ---------- painel ao vivo ----------
CREATE OR REPLACE FUNCTION public.painel_capacidade(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_conn_total int; v_conn_max int; v_oper int; v_jobs int;
  v_runs24 int; v_to24 int; v_to1h int; v_runs1h int;
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
