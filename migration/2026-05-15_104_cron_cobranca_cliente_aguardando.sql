-- Migration 104: cron job pra disparar cobrança automática diária.
--
-- CONTEXTO (Caio 2026-05-15):
-- Cards em AGUARDANDO_CLIENTE há ≥ 4 dias úteis sem retorno recebem email
-- de cobrança autônoma. Máximo 2 disparos por card (controlado em
-- cards.cobranca_cliente_emails_enviados, ver migration 103).
--
-- Cadência: 1x por dia às 12:00 UTC (~09:00 BRT). Horário sem urgência —
-- emails saem todos no mesmo bloco, sem flood.

-- Secret pra cron invocar a edge function (mesma key dos crons existentes)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_cobranca_aguardando_key') THEN
    PERFORM vault.create_secret(
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_sync_bastao_key'),
      'cron_cobranca_aguardando_key',
      'Service role key usada pelo cron pra invocar processar-cobrancas-cliente-aguardando'
    );
  END IF;
END$$;

-- Remove se já existir (idempotência)
SELECT cron.unschedule('cobranca-cliente-aguardando-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cobranca-cliente-aguardando-daily');

SELECT cron.schedule(
  'cobranca-cliente-aguardando-daily',
  '0 12 * * *',  -- 12:00 UTC = 09:00 BRT
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/processar-cobrancas-cliente-aguardando',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_cobranca_aguardando_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);
