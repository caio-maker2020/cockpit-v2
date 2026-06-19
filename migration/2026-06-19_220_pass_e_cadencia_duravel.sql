-- =============================================================================
-- Pass E — cadência durável (quebra o ciclo vicioso de timeout)
--
-- Caio 2026-06-19: o sync-bastao está estourando o timeout de 150s há ~3 dias
-- (153 runs "running" sem finalizar). Causa raiz: o Pass E decide rodar lendo o
-- ÚLTIMO sync-bastao que COMPLETOU (via sync_runs.summary.pass_e.last_full_run_at).
-- Como o sync nunca completa (timeout), esse registro nunca aparece → o gate
-- acha que o Pass E "nunca rodou" → dispara as ~513 raspagens SSW TODO run →
-- estoura → nunca completa → repete. Ciclo vicioso.
--
-- Fix: timestamp DURÁVEL, gravado no INÍCIO da execução do Pass E (sobrevive ao
-- timeout), igual ao padrão registrar_sync_bastao_concluido (marca no início).
-- O gate passa a ler daqui (sempre presente) em vez do summary (só no fim).
-- =============================================================================

ALTER TABLE public.sync_status_global
  ADD COLUMN IF NOT EXISTS ultimo_pass_e_run timestamptz;

-- Carimbo durável do início de uma execução do Pass E (service_role).
CREATE OR REPLACE FUNCTION public.registrar_pass_e_run()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.sync_status_global (id, ultimo_pass_e_run, atualizado_em)
  VALUES (1, now(), now())
  ON CONFLICT (id) DO UPDATE SET
    ultimo_pass_e_run = EXCLUDED.ultimo_pass_e_run,
    atualizado_em = now();
$$;
REVOKE ALL ON FUNCTION public.registrar_pass_e_run() FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.registrar_pass_e_run() TO service_role;

-- Lê os minutos desde o último Pass E (pro gate de 8h). STABLE.
CREATE OR REPLACE FUNCTION public.minutos_desde_ultimo_pass_e()
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN ultimo_pass_e_run IS NULL THEN 999999
    ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - ultimo_pass_e_run)) / 60))::integer
  END
  FROM public.sync_status_global WHERE id = 1;
$$;
REVOKE ALL ON FUNCTION public.minutos_desde_ultimo_pass_e() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.minutos_desde_ultimo_pass_e() TO authenticated, service_role;
