-- =============================================================================
-- Detalhe das FALHAS de automação para o Monitor de Capacidade (Caio 2026-06-30)
--
-- O monitor já mostrava "⚠ N falhas" por dia (rollup automacoes_diarias, mig 250),
-- mas o N era um número morto: não dava pra ver QUAIS jobs falharam nem POR QUÊ.
-- Caio pediu drill-down: clicar no "N falhas" e ver a lista, sem precisar perguntar.
--
-- Esta RPC lê o detalhe direto de cron.job_run_details (mesma fonte que o rollup
-- conta), AGRUPADO por (dia, job, erro) — 14 falhas idênticas do mesmo cron viram
-- 1 linha "14×". Read-only, token-gated, SECURITY DEFINER (igual automacoes_periodo).
--
-- LIMITAÇÃO conhecida: cron.job_run_details só retém ~7 dias (cleanup_cron_logs).
-- O COUNT por dia fica gravado pra sempre no rollup, mas o DETALHE (job/erro) só
-- existe enquanto o dia está dentro da janela de 7 dias. O front avisa isso.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.automacoes_falhas_periodo(p_token text, p_inicio date, p_fim date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v jsonb;
BEGIN
  IF p_token IS DISTINCT FROM 'salexcap7f3k9q2x' THEN
    RAISE EXCEPTION 'token invalido';
  END IF;

  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'dia',           g.dia,
             'job',           g.jobname,
             'erro',          g.erro,
             'ocorrencias',   g.n,
             'primeira_hora', g.primeira,
             'ultima_hora',   g.ultima
           ) ORDER BY g.dia DESC, g.ultima_ts DESC, g.n DESC
         ), '[]'::jsonb)
  INTO v
  FROM (
    SELECT
      (d.start_time AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
      j.jobname,
      -- normaliza quebras de linha e trunca: erros idênticos colapsam num grupo só
      left(regexp_replace(coalesce(d.return_message, ''), E'[\n\r]+', ' ', 'g'), 240) AS erro,
      count(*) AS n,
      to_char((min(d.start_time) AT TIME ZONE 'America/Sao_Paulo'), 'HH24:MI') AS primeira,
      to_char((max(d.start_time) AT TIME ZONE 'America/Sao_Paulo'), 'HH24:MI') AS ultima,
      max(d.start_time) AS ultima_ts
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.status = 'failed'
      AND (d.start_time AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN p_inicio AND p_fim
    GROUP BY 1, 2, 3
  ) g;

  RETURN jsonb_build_object('retencao_dias', 7, 'grupos', v);
END $$;
REVOKE ALL ON FUNCTION public.automacoes_falhas_periodo(text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.automacoes_falhas_periodo(text, date, date) TO anon, authenticated;
