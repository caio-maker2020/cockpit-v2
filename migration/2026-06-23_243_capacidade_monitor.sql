-- =============================================================================
-- MONITOR DE CAPACIDADE — 2 eixos de crescimento (Caio 2026-06-23, pós-apagão).
--
-- Objetivo: enxergar visualmente QUANDO puxar cada alavanca:
--   EIXO PESSOAS  (mais operadores)        -> MAIS ESCRITÓRIO (compute/conexões)
--     sinal de estresse = lotação de conexões (% de max_connections); pico 24h/7d.
--   EIXO ROBÔS    (mais regras/automações) -> SEPARAR OS ROBÔS (réplica/dedicado)
--     sinal de estresse = taxa de "job startup timeout" do cron (worker starvation,
--     a causa-raiz do apagão — ver mig 242). Também conta nº de automações ativas.
--
-- Cada eixo tem um "tamanho" (o que VOCÊ controla: nº operadores / nº automações) e
-- um "estresse" (o sintoma: % conexões / % falha de worker). Quando o estresse de um
-- eixo fica vermelho, é esse eixo que precisa de ação.
--
-- snapshot a cada 10min (cron). Dashboard lê via painel_capacidade (token-gated).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.capacity_snapshots (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts                         timestamptz NOT NULL DEFAULT now(),
  conn_total                 int NOT NULL,
  conn_max                   int NOT NULL,
  conn_pct                   numeric NOT NULL,
  operadores_ativos          int NOT NULL,
  cron_jobs_ativos           int NOT NULL,
  cron_runs_24h              int NOT NULL,
  cron_startup_timeouts_24h  int NOT NULL,
  cron_timeout_pct           numeric NOT NULL,
  status_pessoas             text NOT NULL,   -- verde | amarelo | vermelho
  status_robos               text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capacity_snapshots_ts ON public.capacity_snapshots (ts DESC);

-- Tabela trancada: acesso só pela função SECURITY DEFINER (não exposta ao front cru).
ALTER TABLE public.capacity_snapshots ENABLE ROW LEVEL SECURITY;

-- ---------- snapshot (rodado pelo cron) ----------
CREATE OR REPLACE FUNCTION public.tirar_snapshot_capacidade()
RETURNS public.capacity_snapshots
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_conn_total int; v_conn_max int; v_oper int; v_jobs int;
  v_runs int; v_timeouts int; v_pct numeric; v_tpct numeric;
  v_sp text; v_sr text; v_row public.capacity_snapshots;
BEGIN
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

  INSERT INTO public.capacity_snapshots
    (ts, conn_total, conn_max, conn_pct, operadores_ativos, cron_jobs_ativos,
     cron_runs_24h, cron_startup_timeouts_24h, cron_timeout_pct, status_pessoas, status_robos)
  VALUES
    (now(), v_conn_total, v_conn_max, v_pct, v_oper, v_jobs,
     v_runs, v_timeouts, v_tpct, v_sp, v_sr)
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION public.tirar_snapshot_capacidade() FROM PUBLIC;

-- ---------- leitura p/ o dashboard (token-gated) ----------
CREATE OR REPLACE FUNCTION public.painel_capacidade(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_atual public.capacity_snapshots; v_result jsonb;
BEGIN
  IF p_token IS DISTINCT FROM 'salexcap7f3k9q2x' THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  SELECT * INTO v_atual FROM public.capacity_snapshots ORDER BY ts DESC LIMIT 1;
  SELECT jsonb_build_object(
    'gerado_em', now(),
    'atual', to_jsonb(v_atual),
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

REVOKE ALL ON FUNCTION public.painel_capacidade(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.painel_capacidade(text) TO anon, authenticated;

-- ---------- cron: snapshot a cada 10min (minuto 8,18,... fora do minuto 0) ----------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'snapshot-capacidade-every-10min') THEN
    PERFORM cron.unschedule('snapshot-capacidade-every-10min');
  END IF;
END $$;
SELECT cron.schedule('snapshot-capacidade-every-10min', '8-59/10 * * * *',
                     'SELECT public.tirar_snapshot_capacidade();');
