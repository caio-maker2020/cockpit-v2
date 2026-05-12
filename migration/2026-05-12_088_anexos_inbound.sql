-- ============================================================================
-- Cockpit v2 — Anexos inbound (cliente envia anexo no email de resposta)
-- Data: 2026-05-12
--
-- Caio 2026-05-12 (NF 920161): cliente respondeu email da Larissa com PDF
-- do romaneio de coleta assinado. Gmail polling capturava o texto mas
-- IGNORAVA anexos. Larissa precisava abrir Gmail manualmente pra pegar e
-- anexar no SSW. Solução: gmail-poll-inbox passa a extrair anexos do
-- payload do Gmail, baixa via API, salva no bucket email_anexos (mesmo
-- bucket do outbound) com origem='inbound' + message_inbox_id pra
-- rastreabilidade.
--
-- Schema:
--   - origem text NOT NULL DEFAULT 'outbound' CHECK IN ('inbound','outbound')
--   - message_inbox_id uuid REFERENCES messages_inbox(id) — NULL pra outbound
--
-- Cleanup: cron existente (24h delete pós-envio) NÃO se aplica a inbound —
-- Larissa precisa do anexo persistido pra reusar (anexar em SSW, baixar etc).
-- ============================================================================

ALTER TABLE public.email_anexos
  ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'outbound',
  ADD COLUMN IF NOT EXISTS message_inbox_id uuid REFERENCES public.messages_inbox(id) ON DELETE SET NULL;

ALTER TABLE public.email_anexos
  DROP CONSTRAINT IF EXISTS email_anexos_origem_check;

ALTER TABLE public.email_anexos
  ADD CONSTRAINT email_anexos_origem_check CHECK (origem IN ('inbound', 'outbound'));

CREATE INDEX IF NOT EXISTS idx_email_anexos_message_inbox
  ON public.email_anexos(message_inbox_id)
  WHERE message_inbox_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_anexos_origem_card
  ON public.email_anexos(origem, card_id);

COMMENT ON COLUMN public.email_anexos.origem IS
  'Caio 2026-05-12: distingue anexo enviado pela operadora (outbound) vs '
  'anexo recebido do cliente (inbound). Inbound vinculado a messages_inbox; '
  'outbound vinculado a todo+card. Cleanup automático 24h só pra outbound.';

COMMENT ON COLUMN public.email_anexos.message_inbox_id IS
  'FK pra messages_inbox quando origem=inbound. NULL pra outbound.';
