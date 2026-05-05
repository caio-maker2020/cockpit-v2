-- ============================================================================
-- Cockpit v2 — Gmail OAuth (substitui Postmark pra outbound)
-- Data: 2026-05-04
--
-- Por que: Postmark requer DKIM/Return-Path no DNS do salexpress.com.br pra
-- não cair em spam. Como salexpress.com.br é Google Workspace, podemos
-- enviar via Gmail API com OAuth da operadora — sem mexer em DNS, e com
-- reputação Gmail (zero spam).
--
-- Fluxo OAuth:
--   1. Operadora clica "Conectar Gmail" → Edge Function oauth-gmail-start
--      gera state UUID e retorna URL de autorização do Google.
--   2. Browser dela vai pra accounts.google.com → autoriza escopo
--      gmail.send → Google redireciona pra oauth-gmail-callback?code=X&state=Y.
--   3. Callback troca code por refresh_token, salva em
--      operadores.gmail_oauth_credentials.
--   4. enviar-resposta tenta Gmail API se operador tem credentials, fallback
--      Postmark senão.
-- ============================================================================

-- 1. Coluna nova em operadores: refresh_token + email + escopo (jsonb)
ALTER TABLE public.operadores
  ADD COLUMN IF NOT EXISTS gmail_oauth_credentials jsonb;

COMMENT ON COLUMN public.operadores.gmail_oauth_credentials IS
  'Credenciais OAuth do Gmail da operadora. Formato: {refresh_token, email, scope, conectado_em}. Service Role usa pra refresh access_token a cada envio. NULL = não conectado (fallback Postmark).';

-- 2. Tabela de state pending pra OAuth (TTL 10min)
-- Usada pra correlacionar callback do Google com user_id que iniciou OAuth.
-- State é UUID gerado em oauth-gmail-start, validado em oauth-gmail-callback,
-- depois deletado.
CREATE TABLE IF NOT EXISTS public.oauth_pending_states (
  state uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  expira_em timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_pending_states_expira_em
  ON public.oauth_pending_states(expira_em);

ALTER TABLE public.oauth_pending_states ENABLE ROW LEVEL SECURITY;

-- Só Service Role acessa (Edge Functions usam service role)
DROP POLICY IF EXISTS oauth_pending_states_service_only ON public.oauth_pending_states;
CREATE POLICY oauth_pending_states_service_only
  ON public.oauth_pending_states
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.oauth_pending_states IS
  'States temporários pra fluxo OAuth (Gmail). UUID gerado em oauth-gmail-start, validado em oauth-gmail-callback. TTL 10min. Limpa registros expirados periodicamente.';
