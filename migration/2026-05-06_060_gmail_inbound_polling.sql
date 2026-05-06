-- ============================================================================
-- Cockpit v2 — Gmail inbound polling: cards_emails_outbound + estado polling
-- Data: 2026-05-06
--
-- Regra Caio 2026-05-06: capturar respostas dos clientes a emails enviados
-- pelo Cockpit. Filtro por label Gmail `cockpit-tracked` (zero ruído — não
-- pega emails pessoais da Larissa). Polling 5min via cron.
--
-- Pipeline:
--   Cockpit envia email → executor INSERT cards_emails_outbound + aplica
--   label cockpit-tracked → cliente responde → cron gmail-poll-inbox (5min)
--   detecta reply → lookup card_id em cards_emails_outbound (via In-Reply-To
--   ou thread_id) → INSERT messages_inbox com card_id → vinculador dispara
--   atualizarPropostasAposRespostaCliente → IA popula ia_sugestao_oc_resposta
--   → card vai pra AGUARDANDO_VALIDACAO_HUMANA com sugestão visível.
--
-- gmail_oauth_credentials é COLUNA jsonb em operadores (não tabela). Pra
-- guardar history_id/last_poll_at/cockpit_label_id por operador, criamos
-- tabela separada gmail_polling_state (1:1 com operador).
-- ============================================================================

-- ============================================================================
-- Tabela: cards_emails_outbound — lookup O(1) reply→card
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.cards_emails_outbound (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  todo_id uuid REFERENCES public.todos(id) ON DELETE SET NULL,
  operadora_id uuid REFERENCES public.operadores(id),
  gmail_message_id text NOT NULL UNIQUE,
  gmail_thread_id text NOT NULL,
  message_id_header text,  -- Message-ID header completo (Gmail API retorna sem <>)
  from_email text,
  to_email text,
  subject text,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emails_outbound_message_id
  ON public.cards_emails_outbound(gmail_message_id);
CREATE INDEX IF NOT EXISTS idx_emails_outbound_thread_id
  ON public.cards_emails_outbound(gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_outbound_card_id
  ON public.cards_emails_outbound(card_id);
CREATE INDEX IF NOT EXISTS idx_emails_outbound_msg_id_header
  ON public.cards_emails_outbound(message_id_header)
  WHERE message_id_header IS NOT NULL;

ALTER TABLE public.cards_emails_outbound ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cards_emails_outbound_service_only
  ON public.cards_emails_outbound;
CREATE POLICY cards_emails_outbound_service_only
  ON public.cards_emails_outbound
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS cards_emails_outbound_select_auth
  ON public.cards_emails_outbound;
CREATE POLICY cards_emails_outbound_select_auth
  ON public.cards_emails_outbound
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.cards_emails_outbound IS
  'Caio 2026-05-06: emails enviados pelo Cockpit (via Gmail OAuth do executor). '
  'Indexa gmail_message_id e thread_id pra lookup O(1) quando cliente responde. '
  'Backfill inicial dos card_events RespostaEnviada existentes.';

-- ============================================================================
-- Tabela: gmail_polling_state — checkpoint do polling por operador
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.gmail_polling_state (
  operador_id uuid PRIMARY KEY REFERENCES public.operadores(id) ON DELETE CASCADE,
  cockpit_label_id text,           -- ID do label "cockpit-tracked" no Gmail dela
  history_id text,                  -- checkpoint pra users.history.list (opcional)
  last_poll_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  msgs_processadas_total int NOT NULL DEFAULT 0
);

ALTER TABLE public.gmail_polling_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gmail_polling_state_service_only
  ON public.gmail_polling_state;
CREATE POLICY gmail_polling_state_service_only
  ON public.gmail_polling_state
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.gmail_polling_state IS
  'Estado do polling Gmail por operador. cockpit_label_id é cacheado após '
  '1ª criação. last_poll_at usado pra detectar polling estagnado em alertas.';

-- ============================================================================
-- Backfill cards_emails_outbound: usa card_events RespostaEnviada existentes
-- ============================================================================
INSERT INTO public.cards_emails_outbound
  (card_id, gmail_message_id, gmail_thread_id, from_email, sent_at)
SELECT DISTINCT ON (payload->>'gmail_message_id')
  card_id,
  payload->>'gmail_message_id',
  COALESCE(payload->>'gmail_thread_id', payload->>'gmail_message_id'),
  payload->>'from',
  created_at
FROM public.card_events
WHERE event_type = 'RespostaEnviada'
  AND payload ? 'gmail_message_id'
  AND payload->>'gmail_message_id' IS NOT NULL
ON CONFLICT (gmail_message_id) DO NOTHING;
