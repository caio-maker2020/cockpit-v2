-- =============================================================================
-- Re-scan de e-mail pré-existente para cards EM ESPERA (AGUARDANDO_CLIENTE)
--
-- Caio 2026-06-22: a scan-email-pre-card só dispara no NASCIMENTO do card. Mas o
-- cliente/base costuma abrir uma thread NOVA e separada DEPOIS que o Cockpit já
-- notificou (oc=54). O Cockpit não pega (thread diferente; o fallback do poll
-- exige NF-no-assunto + outbound nas últimas 48h). O card fica preso em
-- AGUARDANDO_CLIENTE achando que ninguém respondeu.
--   Caso âncora: NF 617089 (Duilio/OVD) — notificado 16/06, base abriu thread
--   "ATRASO DE ENTREGA/ EXTRAVIO | NF 617089/2 | ... CHAMADO 1154294" em 22/06.
--
-- Esta migration adiciona um RE-SCAN periódico dos cards em espera. Reusa a MESMA
-- fila/edge/scoring/banner/adoção — só muda o GATILHO. O edge marca o sinal com
-- contexto='card_em_espera' e DESCARTA a própria thread do Cockpit (surfa só a
-- divergente). A trava NF+vínculo-cliente continua valendo (nunca e-mail aleatório).
-- O operador valida e decide seguir; a transição de estado (CLIENTE RESPONDEU) só
-- acontece na ADOÇÃO (import da thread → cliente_respondeu pelo fluxo normal).
-- Gated na MESMA flag scan_email_pre_card_enabled.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. View ganha `contexto` (front discrimina nascimento vs card_em_espera).
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_email_preexistente;
CREATE VIEW public.v_email_preexistente
WITH (security_invoker = on) AS
SELECT
  c.id                                              AS card_id,
  c.nf,
  c.state,
  c.assigned_operator_id,
  c.email_preexistente_sugerido->>'contexto'        AS contexto,
  c.email_preexistente_sugerido->>'detectado_em'    AS detectado_em,
  COALESCE(c.email_preexistente_sugerido->'candidatos', '[]'::jsonb) AS candidatos,
  jsonb_array_length(
    COALESCE(c.email_preexistente_sugerido->'candidatos', '[]'::jsonb)
  )                                                 AS qtd_candidatos
FROM public.cards c
WHERE c.email_preexistente_sugerido IS NOT NULL
  AND c.email_preexistente_sugerido->>'tipo' = 'thread_preexistente'
  AND (c.email_preexistente_sugerido->>'vista_em') IS NULL
  AND (c.email_preexistente_sugerido->>'decidido_em') IS NULL
ORDER BY (c.email_preexistente_sugerido->>'detectado_em') DESC NULLS LAST;

GRANT SELECT ON public.v_email_preexistente TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. Enfileira re-scan dos cards em espera elegíveis (throttle 12h via log).
--    Gated na flag. Idempotente (a fila + o upsert do scan absorvem repetição).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enfileirar_rescan_cards_aguardando(p_limit integer DEFAULT 50)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_on boolean;
  v_count integer := 0;
  r record;
BEGIN
  SELECT enabled INTO v_on FROM public.feature_flags WHERE key = 'scan_email_pre_card_enabled';
  IF NOT COALESCE(v_on, false) THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT c.id
    FROM public.cards c
    WHERE c.state = 'AGUARDANDO_CLIENTE'           -- já notificado, esperando cliente
      AND c.cliente_respondeu_em IS NULL           -- Cockpit não registrou resposta
      AND c.tratativa_email_escolhida IS NULL      -- nenhuma thread já adotada
      AND c.assigned_operator_id IS NOT NULL       -- precisa de caixa Gmail pra buscar
      AND (                                        -- não decidido ainda
        c.email_preexistente_sugerido IS NULL
        OR (c.email_preexistente_sugerido->>'decidido_em') IS NULL
      )
      AND NOT EXISTS (                             -- throttle: 1 scan / 12h por card
        SELECT 1 FROM public.email_preexistente_scan s
        WHERE s.card_id = c.id
          AND s.scaneado_em > now() - interval '12 hours'
      )
    ORDER BY c.created_at ASC                      -- quem espera há mais tempo primeiro
    LIMIT GREATEST(p_limit, 0)
  LOOP
    PERFORM pgmq.send('scan_email_pre_card', jsonb_build_object(
      'card_id', r.id,
      'contexto', 'card_em_espera'
    ));
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.enfileirar_rescan_cards_aguardando(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enfileirar_rescan_cards_aguardando(integer) TO service_role;

COMMENT ON FUNCTION public.enfileirar_rescan_cards_aguardando(integer) IS
  'Enfileira re-scan (scan_email_pre_card, contexto=card_em_espera) dos cards em '
  'AGUARDANDO_CLIENTE sem resposta registrada. Gated na flag, throttle 12h. '
  'Pega thread divergente que o cliente abriu após a notificação. Caio 2026-06-22.';

-- ----------------------------------------------------------------------------
-- 3. Cron horário (minuto 7 pra não colidir com outros crons na virada da hora).
-- ----------------------------------------------------------------------------
SELECT cron.unschedule('rescan-cards-aguardando-hourly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rescan-cards-aguardando-hourly');

SELECT cron.schedule(
  'rescan-cards-aguardando-hourly',
  '7 * * * *',
  $$ SELECT public.enfileirar_rescan_cards_aguardando(50); $$
);
