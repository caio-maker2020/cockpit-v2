-- ============================================================================
-- Cockpit v2 — Headers de thread em messages_inbox
-- Data: 2026-05-04
--
-- Pra que: permitir que o vinculador linke novas mensagens à mesma thread
-- (mesmo card) baseado em In-Reply-To, sem precisar re-extrair NF do
-- conteúdo. E pra que a Larissa, ao responder pelo Cockpit, possa montar
-- email com headers In-Reply-To + References corretos (Gmail entende
-- como continuação da thread).
--
-- Postmark Inbound traz esses headers no raw_payload[Headers]. Ingestor
-- extrai e popula. Frontend lê quando renderiza timeline.
-- ============================================================================

ALTER TABLE public.messages_inbox
  ADD COLUMN IF NOT EXISTS message_id_header text,
  ADD COLUMN IF NOT EXISTS in_reply_to_header text,
  ADD COLUMN IF NOT EXISTS references_header text;

-- Index pra busca rápida no vinculador: "achar mensagem cujo Message-ID
-- bate com In-Reply-To do email novo"
CREATE INDEX IF NOT EXISTS idx_messages_inbox_message_id
  ON public.messages_inbox(message_id_header)
  WHERE message_id_header IS NOT NULL;

COMMENT ON COLUMN public.messages_inbox.message_id_header IS
  'Header Message-ID do email. Usado pelo vinculador pra linkar respostas (próximo email com In-Reply-To = esse Message-ID linka ao mesmo card).';

COMMENT ON COLUMN public.messages_inbox.in_reply_to_header IS
  'Header In-Reply-To do email. Se preenchido, esse email é resposta a outro — vinculador busca origem por message_id_header.';

COMMENT ON COLUMN public.messages_inbox.references_header IS
  'Header References do email (cadeia de Message-IDs anteriores na thread). Usado pra Gmail manter thread quando Larissa responde pelo Cockpit.';
