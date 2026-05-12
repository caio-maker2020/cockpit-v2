-- ============================================================================
-- Cockpit v2 — Cleanup histórico SSW após 24h
-- Data: 2026-05-12
--
-- Caio 2026-05-12: snapshot de historico_ssw expira em 24h pra economizar
-- storage. Larissa pode sempre clicar "Trazer Histórico SSW" pra puxar de
-- novo (incluindo dentro das 24h pra forçar refresh — botão sempre habilitado).
--
-- Cron roda DE HORA EM HORA — pra cada card cuja última puxada foi há mais
-- de 24h, zera as 2 colunas. UPDATE direto, sem chamar edge function.
-- ============================================================================

SELECT cron.unschedule('cleanup-historico-ssw-every-hour')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-historico-ssw-every-hour');

SELECT cron.schedule(
  'cleanup-historico-ssw-every-hour',
  '0 * * * *',  -- todo minuto 0 (de hora em hora)
  $$
  UPDATE public.cards
  SET historico_ssw = NULL,
      historico_ssw_atualizado_em = NULL
  WHERE historico_ssw_atualizado_em IS NOT NULL
    AND historico_ssw_atualizado_em < now() - interval '24 hours';
  $$
);
