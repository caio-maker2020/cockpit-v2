-- Migration 097: ajusta cadência do sync-bastao de 2min → 30min.
--
-- CONTEXTO (Caio 2026-05-14):
-- Bastão RPA atualiza ~1h em 1h. Sync rodando a cada 2min lê N vezes a
-- mesma "atualização" do Bastão (planilha imutável) — redundante. Com o
-- fix do guard `bastaoEhMesmoSnapshotDoLancamento`, as leituras redundantes
-- viraram NO-OP corretas, mas o sync ainda gasta queries DB + invoca edge
-- function 30x por hora pra basicamente nada.
--
-- Nova cadência 30min:
-- - Cobre janela típica de mudança no Bastão (1h em 1h, com algumas vezes
--   mais frequentes).
-- - Reduz superfície de bug (menos execuções = menos chances de race
--   condition reabrir card que SSW interno acabou de transferir).
-- - Reduz custo: ~30 invocações/hora → 2 invocações/hora (15x menos).
--
-- Latência percebida pelo operador continua aceitável: card novo do Bastão
-- aparece no Cockpit em até 30min após RPA Bastão pegar.

-- Idempotência: remove job antigo se existir
SELECT cron.unschedule('sync-bastao-every-2min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-bastao-every-2min');

SELECT cron.unschedule('sync-bastao-every-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-bastao-every-5min');

SELECT cron.unschedule('sync-bastao-every-30min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-bastao-every-30min');

SELECT cron.schedule(
  'sync-bastao-every-30min',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/sync-bastao',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);
