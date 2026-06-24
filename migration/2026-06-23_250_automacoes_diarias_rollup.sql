-- =============================================================================
-- Histórico DIÁRIO de execuções de automação (Caio 2026-06-24) — acumula ALÉM
-- dos 7 dias do log de cron, pra dar pra ver o crescimento ("estamos usando cada
-- vez mais") e filtrar por período.
--
-- cron.job_run_details só retém 7 dias (cleanup_cron_logs). Então persisto um
-- rollup diário próprio: 1 linha por dia (BRT) com executadas + falhas. Um cron
-- consolida a cada 30min (recontando hoje+ontem do log enquanto ele existe);
-- depois que o dia "envelhece" e sai do log, o número fica gravado aqui pra sempre.
-- Backfill inicial com os ~8 dias que o log ainda tem (17-24/06).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.automacoes_diarias (
  dia           date PRIMARY KEY,
  executadas    int NOT NULL DEFAULT 0,
  falhas        int NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.automacoes_diarias ENABLE ROW LEVEL SECURITY;  -- acesso só via função

-- Consolida (upsert) os últimos N dias a partir do log de cron. Idempotente.
CREATE OR REPLACE FUNCTION public.consolidar_automacoes_diarias(p_dias int DEFAULT 2)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.automacoes_diarias (dia, executadas, falhas, atualizado_em)
  SELECT (start_time AT TIME ZONE 'America/Sao_Paulo')::date,
         count(*) FILTER (WHERE status='succeeded'),
         count(*) FILTER (WHERE status='failed'),
         now()
  FROM cron.job_run_details
  WHERE start_time >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')
                       - make_interval(days => p_dias - 1)) AT TIME ZONE 'America/Sao_Paulo'
  GROUP BY 1
  ON CONFLICT (dia) DO UPDATE
    SET executadas = EXCLUDED.executadas, falhas = EXCLUDED.falhas, atualizado_em = now();
END $$;
REVOKE ALL ON FUNCTION public.consolidar_automacoes_diarias(int) FROM PUBLIC;

-- Backfill: tudo que o log ainda tem (~8 dias).
SELECT public.consolidar_automacoes_diarias(8);

-- Leitura por período (token-gated, read-only).
CREATE OR REPLACE FUNCTION public.automacoes_periodo(p_token text, p_inicio date, p_fim date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v jsonb;
BEGIN
  IF p_token IS DISTINCT FROM 'salexcap7f3k9q2x' THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  SELECT jsonb_build_object(
    'inicio', p_inicio,
    'fim', p_fim,
    'total_executadas', coalesce(sum(executadas), 0),
    'total_falhas',     coalesce(sum(falhas), 0),
    'dias_com_dado',    count(*),
    'media_dia',        coalesce(round(avg(executadas))::int, 0),
    'dias', coalesce(jsonb_agg(jsonb_build_object(
              'dia', dia, 'executadas', executadas, 'falhas', falhas) ORDER BY dia), '[]'::jsonb)
  ) INTO v
  FROM public.automacoes_diarias
  WHERE dia >= p_inicio AND dia <= p_fim;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.automacoes_periodo(text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.automacoes_periodo(text, date, date) TO anon, authenticated;

-- Cron: consolida hoje+ontem a cada 30min (minutos 19 e 49, fora do minuto 0).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'consolidar-automacoes-diarias-30min') THEN
    PERFORM cron.unschedule('consolidar-automacoes-diarias-30min');
  END IF;
END $$;
SELECT cron.schedule('consolidar-automacoes-diarias-30min', '19,49 * * * *',
                     'SELECT public.consolidar_automacoes_diarias(2);');
