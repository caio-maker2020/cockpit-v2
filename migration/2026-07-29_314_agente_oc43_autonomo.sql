-- ============================================================================
-- Cockpit v2 — infra do agente autônomo oc 43
-- Duílio 2026-07-29 (INV-061)
--
-- Automatiza cards em oc 43 ("manutenção perecível realizada" — Relacionamento):
--   - oc anterior no SSW ∈ {3,6,8,9,10,11,13,16,17,18,19,20,23,31,35} → lança oc 49
--   - qualquer outra oc anterior → lança oc 55
--   - sem oc anterior / SSW já moveu → não age (deixa AVH manual)
-- Lançamento via envelope lancarSswPortal (tripé + idempotência), igual oc13.
--
-- Rollout: SHADOW primeiro. Master flag ON (agente roda e RECOMENDA), autonomia
-- flag OFF (não lança no SSW). Caio confere um lote real e liga a autonomia com
-- 1 UPDATE em feature_flags. Espelha o par de flags do extravio/ressarcimento.
--
-- Boas práticas Postgres aplicadas:
--   * ADD COLUMN IF NOT EXISTS (aditivo, idempotente, sem backfill/lock pesado)
--   * colunas nullable → herdam a RLS existente de `cards` (sem policy nova)
--   * feature_flags: ON CONFLICT (key) DO NOTHING (não sobrescreve toggle do Caio)
--   * cron.schedule idempotente (unschedule antes) — reusa secret já existente
--   * volume ~3-5 cards/dia → sem índice novo (state+oc já filtram barato)
-- ============================================================================

-- 1. Marcadores de processamento no card (mirror de agente_extravio_*).
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS agente_oc43_status       text,        -- null=não visto | recomendado | lancou_49 | lancou_55 | nao_rodou | erro
  ADD COLUMN IF NOT EXISTS agente_oc43_motivo       text,        -- detalhe (ex: sem_oc_anterior, oc_mudou_no_ssw)
  ADD COLUMN IF NOT EXISTS agente_oc43_oc_anterior  smallint,    -- oc imediatamente anterior à 43 achada no SSW
  ADD COLUMN IF NOT EXISTS agente_oc43_checado_em   timestamptz; -- quando o agente rodou pra esse card

COMMENT ON COLUMN public.cards.agente_oc43_status IS
  'Agente oc43 (Duílio 2026-07-29): null=não visto, recomendado (shadow), lancou_49/lancou_55, nao_rodou, erro.';

-- 2. Feature flags (par master + autonomia). SHADOW: master ON, autonomia OFF.
INSERT INTO public.feature_flags (key, enabled)
VALUES
  ('oc43_cockpit_enabled', true),          -- agente roda (varre + recomenda)
  ('oc43_agente_autonomo_enabled', false)  -- OFF = shadow (recomenda, não lança). Caio liga depois.
ON CONFLICT (key) DO NOTHING;

-- 3. Cron: varre a cada 10min (agente checa horário comercial internamente).
--    Reusa o secret cron_prioridades_ai_key (mesmo service_role dos outros agentes).
SELECT cron.unschedule('agente-oc43-autonomo') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'agente-oc43-autonomo'
);

SELECT cron.schedule(
  'agente-oc43-autonomo',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-oc43-autonomo',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);
