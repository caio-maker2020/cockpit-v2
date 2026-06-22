-- =============================================================================
-- Scan de e-mail pré-existente no nascimento do card — infra de isolamento
--
-- Caio 2026-06-22: hoje o Cockpit só "enxerga" um e-mail quando foi ELE que
-- originou a thread (casa resposta→card por cards_emails_outbound.gmail_thread_id).
-- Mas o cliente — ou uma base/parceiro — costuma ABRIR a conversa ANTES de
-- qualquer card, e o operador trata manualmente dentro dela. O Cockpit nunca vê
-- → perde o tracking e o agente sugere ações "do zero".
--   Casos âncora: NF 30459/30460 (Victor / ALFAPARF-DBDC, cliente abriu a thread),
--   NF 114668/114714 (Duilio / OVD, base abriu a thread).
--
-- Esta migration é o PASSO 0 (infra) — NÃO ativa nada em produção:
--   1. Sinal no card (cards.email_preexistente_sugerido) — molde mudanca_suspeita.
--   2. View do banner (v_email_preexistente) — molde v_mudancas_suspeitas.
--   3. Tabela de log/idempotência (email_preexistente_scan) — molde email_ssw_eventos.
--   4. Feature flag DESLIGADA (scan_email_pre_card_enabled).
--   5. Filas pgmq (scan_email_pre_card + importar_thread_adotada).
--   6. Cron do edge scan-email-pre-card (consome as 2 filas).
--
-- Quando ON, vale pra TODOS os operadores (sem whitelist). Single-tenant Sal
-- Express. Não toca idempotência SSW nem confirmação SSW.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Sinal no card: sugestão de thread de e-mail pré-existente.
--
-- jsonb {
--   tipo: 'thread_preexistente',
--   detectado_em, vista_em, decidido_em, decisao ('seguir'|'novo'|null),
--   candidatos: [ { gmail_thread_id, assunto, score, nf_no_assunto,
--                   iniciada_em, qtd_mensagens, participantes[], preview[] } ]
-- }
-- ----------------------------------------------------------------------------
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS email_preexistente_sugerido jsonb;

COMMENT ON COLUMN public.cards.email_preexistente_sugerido IS
  'Sugestão de thread de e-mail pré-existente do cliente sobre a NF, detectada no '
  'nascimento do card pelo edge scan-email-pre-card. jsonb {tipo,detectado_em,'
  'vista_em,decidido_em,decisao,candidatos[]}. Front: banner via v_email_preexistente; '
  'some ao decidir (seguir/novo) ou snooze (vista_em). Caio 2026-06-22.';

-- Índice parcial p/ o banner (poucos cards têm sinal ativo e não-decidido).
CREATE INDEX IF NOT EXISTS idx_cards_email_preexistente
  ON public.cards(assigned_operator_id)
  WHERE email_preexistente_sugerido IS NOT NULL
    AND (email_preexistente_sugerido->>'vista_em') IS NULL
    AND (email_preexistente_sugerido->>'decidido_em') IS NULL;

-- ----------------------------------------------------------------------------
-- 2. View do banner — só os não-vistos/não-decididos, RLS por operador
--    (security_invoker respeita a RLS já existente de cards).
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_email_preexistente;
CREATE VIEW public.v_email_preexistente
WITH (security_invoker = on) AS
SELECT
  c.id                                              AS card_id,
  c.nf,
  c.state,
  c.assigned_operator_id,
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
-- 3. Log de TODO scan avaliado (auditável + idempotência).
--
-- UNIQUE(card_id): um scan por card. O edge faz upsert on conflict (re-scan
-- atualiza). A decisão do operador (seguir/novo) também marca aqui (resultado +
-- decidido_em), além do card_event. resultado documenta POR QUE classificou
-- (ou não) — debug de falso negativo/positivo. NÃO guarda snippet de e-mail não
-- relacionado (só candidatos que passaram a trava NF+cliente).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_preexistente_scan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  nf text,
  operador_id uuid REFERENCES public.operadores(id) ON DELETE SET NULL,
  candidatos_total integer NOT NULL DEFAULT 0,    -- candidatos que passaram a trava
  melhor_score integer,
  melhor_thread_id text,
  resultado text,                                 -- 'sugerido' | 'nenhum_candidato' |
                                                  -- 'sem_credencial_gmail' | 'sem_nf' |
                                                  -- 'erro' | 'adotado' | 'descartado'
  detalhe jsonb,                                  -- debug: query usada, contagens pré-filtro
  erro text,
  scaneado_em timestamptz NOT NULL DEFAULT now(),
  decidido_em timestamptz,
  CONSTRAINT uniq_email_preexistente_scan_card UNIQUE (card_id)
);

CREATE INDEX IF NOT EXISTS idx_email_preexistente_scan_scaneado
  ON public.email_preexistente_scan(scaneado_em DESC);
CREATE INDEX IF NOT EXISTS idx_email_preexistente_scan_resultado
  ON public.email_preexistente_scan(resultado, scaneado_em DESC) WHERE resultado IS NOT NULL;

ALTER TABLE public.email_preexistente_scan ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_preexistente_scan_service_only ON public.email_preexistente_scan;
CREATE POLICY email_preexistente_scan_service_only
  ON public.email_preexistente_scan
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.email_preexistente_scan IS
  'Log de todo scan de e-mail pré-existente avaliado pelo edge scan-email-pre-card. '
  'UNIQUE(card_id) = 1 scan por card (upsert no re-scan). resultado documenta a '
  'classificação. RLS service-only. Caio 2026-06-22.';

-- ----------------------------------------------------------------------------
-- 4. Feature flag (DESLIGADA) — liga/desliga sem deploy.
-- ----------------------------------------------------------------------------
INSERT INTO public.feature_flags (key, description, enabled) VALUES
  ('scan_email_pre_card_enabled',
   'Liga a busca de tratativa de e-mail pré-existente no nascimento do card '
   '(scan-email-pre-card). OFF = sync-bastao/sync-extravios/criar-card-via-ssw '
   'não enfileiram scan. Quando ON, vale pra todos os operadores. Caio 2026-06-22.',
   false)
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 5. Filas pgmq — scan (busca no nascimento) e importação da thread adotada.
--    Idempotente: só cria se ainda não existir.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'scan_email_pre_card') THEN
    PERFORM pgmq.create('scan_email_pre_card');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'importar_thread_adotada') THEN
    PERFORM pgmq.create('importar_thread_adotada');
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 5b. Estende a whitelist das RPCs pgmq pras 2 filas novas (CREATE OR REPLACE
--     preservando o corpo da mig 024 + os DEFAULTs). Sem isso, enqueue/read/
--     delete levantam 'Fila desconhecida'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_to_pgmq(
  queue_name text,
  payload jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $$
DECLARE
  msg_id bigint;
BEGIN
  IF queue_name NOT IN ('agent_intake', 'agent_specialist', 'agent_executor', 'respostas_envio', 'scan_email_pre_card', 'importar_thread_adotada', 'dead_letter') THEN
    RAISE EXCEPTION 'Fila desconhecida: %', queue_name;
  END IF;
  msg_id := pgmq.send(queue_name, payload);
  RETURN msg_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.enqueue_to_pgmq(text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.read_from_pgmq(
  queue_name text,
  vt_seconds integer DEFAULT 60,
  qty integer DEFAULT 10
) RETURNS TABLE(
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $$
BEGIN
  IF queue_name NOT IN ('agent_intake', 'agent_specialist', 'agent_executor', 'respostas_envio', 'scan_email_pre_card', 'importar_thread_adotada', 'dead_letter') THEN
    RAISE EXCEPTION 'Fila desconhecida: %', queue_name;
  END IF;
  RETURN QUERY
  SELECT m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
  FROM pgmq.read(queue_name, vt_seconds, qty) AS m;
END;
$$;
GRANT EXECUTE ON FUNCTION public.read_from_pgmq(text, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.delete_from_pgmq(
  queue_name text,
  msg_id bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $$
BEGIN
  IF queue_name NOT IN ('agent_intake', 'agent_specialist', 'agent_executor', 'respostas_envio', 'scan_email_pre_card', 'importar_thread_adotada', 'dead_letter') THEN
    RAISE EXCEPTION 'Fila desconhecida: %', queue_name;
  END IF;
  RETURN pgmq.delete(queue_name, msg_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_from_pgmq(text, bigint) TO service_role;

-- ----------------------------------------------------------------------------
-- 6. Cron do edge scan-email-pre-card (consome as 2 filas a cada 2min).
--    Reusa o vault secret cron_sync_bastao_key (service role key), como o
--    gmail-poll (mig 061). 2min dá responsividade à adoção sem custo relevante.
-- ----------------------------------------------------------------------------
SELECT cron.unschedule('scan-email-pre-card-every-2min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scan-email-pre-card-every-2min');

SELECT cron.schedule(
  'scan-email-pre-card-every-2min',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/scan-email-pre-card',
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
