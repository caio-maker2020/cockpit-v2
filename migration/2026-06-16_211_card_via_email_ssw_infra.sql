-- =============================================================================
-- Card antecipado via e-mail automático do SSW — infraestrutura de teste
--
-- Caio 2026-06-16: o SSW envia e-mails de notificação (sswemail@ssw.inf.br) ao
-- cliente NO MOMENTO em que a ocorrência é lançada — antes do prazo vencer, logo
-- antes de a NF aparecer no Bastão. Isso cria tratativa duplicada: cliente
-- recebe e responde ao e-mail de extravio (oc=06), e dias depois o operador
-- re-notifica o mesmo extravio quando o card finalmente entra via Bastão (oc=49).
-- Casos âncora: NF 345523 (Acácia), NF 2163170 (Rio Clarense).
--
-- Esta migration é o PASSO 0 (infra de isolamento) — NÃO ativa nada em produção:
--   1. Operador técnico dedicado COCKPIT (cockpit@salexpress.com.br), isolado.
--   2. Feature flag DESLIGADA por padrão.
--   3. Tabela de log/idempotência (email_ssw_eventos).
--   4. Whitelist de NFs de teste (email_ssw_test_nfs) — só essas viram card.
--
-- Padrão espelhado de webhook_ssw_eventos / webhook_ssw_test_nfs
-- (migration 2026-05-22_151). RLS service-only: gerenciado via SQL, sem UI.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Operador técnico dedicado COCKPIT
--
-- cockpit_ativo=true → os agentes (vinculador/executor/sugere-ocs/priorizador)
-- processam os cards de teste normalmente. carteira/segmentos VAZIOS → o
-- operador-resolver (Path 1 carteira, Path 3 segmento) nunca atribui card real
-- do Bastão a ele. NFs/CT-es do teste são fictícios. gmail_oauth_credentials
-- fica NULL até o Caio conectar o Gmail via fluxo OAuth (login manual no Google).
-- ----------------------------------------------------------------------------
INSERT INTO public.operadores (nome, email, email_relacionamento, papel, carteira, segmentos, ativo, cockpit_ativo)
VALUES (
  'COCKPIT',
  'cockpit@salexpress.com.br',
  'cockpit@salexpress.com.br',
  'operador',
  '{}'::text[],
  '{}'::text[],
  true,
  true
)
ON CONFLICT (nome) DO NOTHING;

COMMENT ON COLUMN public.operadores.gmail_oauth_credentials IS
  'JSONB {refresh_token, email, scope, conectado_em, ...}. NULL = Gmail não '
  'conectado. Populado SÓ via fluxo OAuth (oauth-gmail-start → callback). '
  'Operador COCKPIT (Caio 2026-06-16) usa isso pra receber os e-mails do SSW.';

-- ----------------------------------------------------------------------------
-- 2. Feature flag (DESLIGADA) — liga-desliga sem deploy
-- ----------------------------------------------------------------------------
INSERT INTO public.feature_flags (key, description, enabled) VALUES
  ('card_via_email_ssw_enabled',
   'Liga a criação antecipada de card a partir do e-mail automático do SSW '
   '(sswemail@ssw.inf.br). Só roda no operador COCKPIT, só pras NFs em '
   'email_ssw_test_nfs. OFF = gmail-poll-inbox ignora os e-mails do SSW.',
   false)
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. Log de TODO e-mail SSW avaliado (auditável + idempotência)
--
-- UNIQUE(gmail_message_id, nf): o mesmo e-mail pode ter N NFs ("2 279985,
-- 2 279986") e o gmail-poll pode re-listar a msg — o INSERT-antes-de-criar
-- com conflito = já processado, pula. Também é a fonte de verdade pra rollback
-- (listar/cancelar cards-email) e pro dry-run dos passos 1-2.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_ssw_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id text NOT NULL,
  gmail_thread_id text,
  operador_id uuid REFERENCES public.operadores(id) ON DELETE SET NULL,
  remetente_email text,                    -- esperado: sswemail@ssw.inf.br
  nf text,                                 -- normalizada (sem zeros à esquerda)
  oc integer,                              -- código da ocorrência no e-mail (ex: 6)
  ctrc_escolhido text,                     -- CTRC resolvido via SSW (null se ambíguo/sem)
  ctrc_ambiguo boolean NOT NULL DEFAULT false,
  cnpj_pagador text,
  na_whitelist boolean NOT NULL DEFAULT false,
  card_id uuid REFERENCES public.cards(id) ON DELETE SET NULL,
  card_acao text,                          -- 'detectado_dry_run' | 'criado' |
                                           -- 'ignorado_whitelist' | 'ignorado_oc' |
                                           -- 'sem_ctrc_ativo' | 'ctrc_ambiguo' |
                                           -- 'card_ja_existe_corrida' | 'erro'
  erro text,
  raw_email_snippet text,                  -- trecho do corpo pra debug do parser
  recebido_em timestamptz NOT NULL DEFAULT now(),
  processado_em timestamptz,
  CONSTRAINT uniq_email_ssw_eventos_msg_nf UNIQUE (gmail_message_id, nf)
);

CREATE INDEX IF NOT EXISTS idx_email_ssw_eventos_recebido_em
  ON public.email_ssw_eventos(recebido_em DESC);
CREATE INDEX IF NOT EXISTS idx_email_ssw_eventos_nf
  ON public.email_ssw_eventos(nf, recebido_em DESC) WHERE nf IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_ssw_eventos_card
  ON public.email_ssw_eventos(card_id) WHERE card_id IS NOT NULL;

ALTER TABLE public.email_ssw_eventos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_ssw_eventos_service_only ON public.email_ssw_eventos;
CREATE POLICY email_ssw_eventos_service_only
  ON public.email_ssw_eventos
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.email_ssw_eventos IS
  'Log de todo e-mail do SSW (sswemail@ssw.inf.br) avaliado pelo ramo de criação '
  'antecipada no gmail-poll-inbox. UNIQUE(gmail_message_id,nf) garante '
  'idempotência (múltiplas NFs por e-mail + re-list da msg). Caio 2026-06-16.';

-- ----------------------------------------------------------------------------
-- 4. Whitelist de NFs de teste — gate primário ("só essas NFs viram card")
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_ssw_test_nfs (
  nf text PRIMARY KEY,                      -- normalizada (sem zeros à esquerda)
  cliente_nome text,
  cnpj_pagador text,
  motivo text,
  adicionado_por text,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_ssw_test_nfs_ativo
  ON public.email_ssw_test_nfs(ativo) WHERE ativo;

ALTER TABLE public.email_ssw_test_nfs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_ssw_test_nfs_service_only ON public.email_ssw_test_nfs;
CREATE POLICY email_ssw_test_nfs_service_only
  ON public.email_ssw_test_nfs
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.email_ssw_test_nfs IS
  'Whitelist de NFs (fictícias) que podem virar card via e-mail do SSW. Vazia ou '
  'ativo=false → o ramo só loga em email_ssw_eventos, sem criar card. Caio '
  '2026-06-16: gate primário do teste, NF é o filtro mais forte.';
