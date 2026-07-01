-- =============================================================================
-- Re-agenda o cron sync-extravios-bastao — agora RECONCILIADOR (não puxa Bastão)
--
-- Caio 2026-06-24: a mig 219 aposentou o cron antigo porque ele DUPLICAVA o pull
-- de extravios que o sync-bastao passou a fazer. O edge foi REESCRITO: agora NÃO
-- puxa o relatório filtrado — pra cada card da aba EXTRAVIOS consulta o Bastão
-- POR NF (fetchPendenciasByNfs) sob GATE DE FRESCOR e decide a saída (oc nova →
-- roteia; NF ausente do Bastão fresco → finalizou → RESOLVIDO). SSW não é usado
-- aqui (só no conflito de oc lançada pelo Cockpit + pré-checagem do agente). Como
-- não duplica o pull do sync-bastao, pode ter cron próprio (motivo da mig 219 não
-- se aplica). Ver INV-017 + _shared/reconciliar-extravios-bastao.ts.
--
-- REGRA INVIOLÁVEL (aba EXTRAVIOS): card em EXTRAVIO_MONITORADO ⟺ oc atual ∈
-- {6,9,16}. Trocou a oc → SAI da aba roteado pela responsabilidade (20→AGUARDANDO
-- VOCÊ, 33→TRANSFERIDO, 1/30/32→RESOLVIDO). Ver _shared/extravio-routing.ts +
-- _shared/reconciliar-extravios-ssw.ts e INV-015.
--
-- Cadência 10min: o sync-bastao roda 5/5min e mantém os extravios in-pull frescos;
-- um card só vira "órfão" quando cai do pull, então 10min reconcilia rápido sem
-- martelar o SSW. O edge é gated por feature_flags.extravios_cockpit_enabled.
-- =============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('sync-extravios-bastao')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-extravios-bastao');
END $$;

SELECT cron.schedule(
  'sync-extravios-bastao',
  '*/10 * * * *',  -- a cada 10min (reconciliação de órfãos, não pull)
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/sync-extravios-bastao',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);
