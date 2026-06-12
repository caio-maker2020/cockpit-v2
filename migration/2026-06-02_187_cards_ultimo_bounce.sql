-- ============================================================================
-- Cockpit v2 — cards.ultimo_bounce_em / ultimo_bounce_payload
-- Caio 2026-06-02
--
-- CONTEXTO: NF 5826 MIX MOTO — email enviado pro cliente retornou bounce 550
-- spam, mas a operadora não foi avisada. Cliente recebeu por algum caminho
-- alternativo (quarentena/alias), mas sem o aviso a operadora não sabia que
-- o canal estava degradado. Adicionar campos no card pra que o gmail-poll-inbox
-- registre o último bounce quando detectado (e front mostre banner amarelo).
--
-- skill: supabase-postgres-best-practices
--   * Colunas novas SEM default — populadas só quando há bounce
--   * Index parcial em ultimo_bounce_em (pra listagem rápida "cards com bounce
--     recente" em telas de auditoria)
-- ============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS ultimo_bounce_em timestamptz,
  ADD COLUMN IF NOT EXISTS ultimo_bounce_payload jsonb;

CREATE INDEX IF NOT EXISTS idx_cards_ultimo_bounce_recente
  ON public.cards (ultimo_bounce_em DESC)
  WHERE ultimo_bounce_em IS NOT NULL;

COMMENT ON COLUMN public.cards.ultimo_bounce_em IS
  'Caio 2026-06-02: timestamp do último bounce SMTP capturado pelo gmail-poll-inbox '
  '(remetente mailer-daemon/postmaster). Front mostra banner amarelo no card alertando '
  'que o email pode não ter chegado ao cliente.';

COMMENT ON COLUMN public.cards.ultimo_bounce_payload IS
  'JSON com detalhes do bounce: {destinatario, motivo_smtp, gmail_message_id, subject_original}. '
  'Operadora usa pra confirmar recebimento por outro canal antes de aguardar resposta.';
