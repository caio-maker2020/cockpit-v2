-- Migration 103: contadores de cobrança automática em AGUARDANDO_CLIENTE.
--
-- CONTEXTO (Caio 2026-05-15):
-- Quando Cockpit lança oc=54 + email pro cliente, card vai pra AGUARDANDO_CLIENTE.
-- Se cliente não responder em 4 dias úteis, sistema dispara email autônomo de
-- cobrança ("{nome}, estamos aguardando um retorno..."). Idempotente — máximo
-- 2 cobranças automáticas (4d + 8d), depois para. Operador também pode
-- disparar manualmente via aba RESPOSTA.
--
-- Helper function `dias_uteis_entre(ts1, ts2)` calcula dias úteis (seg-sex)
-- entre dois timestamps. Usado pelo cron pra decidir quando cobrar.

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS cobranca_cliente_emails_enviados integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cobranca_cliente_ultima_em timestamptz;

COMMENT ON COLUMN public.cards.cobranca_cliente_emails_enviados IS
  'Quantos emails AUTOMÁTICOS de cobrança foram enviados pro cliente neste '
  'card em AGUARDANDO_CLIENTE. Máximo 2 (4d + 8d). Disparo manual via aba '
  'RESPOSTA NÃO incrementa esse contador. Caio 2026-05-15.';

COMMENT ON COLUMN public.cards.cobranca_cliente_ultima_em IS
  'Timestamp da última cobrança automática (qualquer disparo). Cron usa pra '
  'agendar o próximo (intervalo 4 dias úteis). Caio 2026-05-15.';

-- Helper: dias úteis (seg-sex) entre 2 timestamps. Ignora feriados (overkill
-- pra fase atual; pode ajustar depois com tabela de feriados se necessário).
CREATE OR REPLACE FUNCTION public.dias_uteis_entre(t1 timestamptz, t2 timestamptz)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  WITH dias AS (
    SELECT generate_series(
      date_trunc('day', t1)::date + 1,  -- exclui o próprio dia do envio
      date_trunc('day', t2)::date,
      interval '1 day'
    )::date AS d
  )
  SELECT count(*)::integer FROM dias
  WHERE extract(dow FROM d) NOT IN (0, 6);  -- 0=domingo, 6=sábado
$$;

COMMENT ON FUNCTION public.dias_uteis_entre IS
  'Conta dias úteis (seg-sex) entre 2 timestamps. Usado pelo cron de cobrança '
  'automática (4 dias úteis sem retorno do cliente = trigger). Não considera '
  'feriados ainda. Caio 2026-05-15.';

-- Audit: índice pra cron achar candidatos rapidamente
CREATE INDEX IF NOT EXISTS idx_cards_cobranca_pendente
  ON public.cards (state, cobranca_cliente_emails_enviados, cobranca_cliente_ultima_em)
  WHERE state = 'AGUARDANDO_CLIENTE' AND cobranca_cliente_emails_enviados < 2;
