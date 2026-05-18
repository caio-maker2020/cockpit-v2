-- ============================================================================
-- Cockpit v2 — Isolamento RLS por operador em 3 tabelas operacionais
-- Data: 2026-05-18
--
-- Bug 2026-05-18 (caso âncora aba AUDITORIA): Duilio via cards/emails/anexos
-- da Larissa. Policies estavam USING(true), permitindo qualquer authenticated
-- ler tudo. Mesma família do bug 2026-05-15 corrigido em CADASTROS.
--
-- Regra global (memory feedback_separacao_operador_cliente):
-- 1 CNPJ = 1 operador. Operador só vê o que é seu via
-- card_visivel_pelo_operador_atual(). Gestor vê tudo.
--
-- Tabelas corrigidas:
--   - cards_auditoria          (snapshot JSON guarda assigned_operator_id)
--   - cards_emails_outbound    (FK card_id → JOIN com cards)
--   - email_anexos             (FK card_id → JOIN com cards)
--
-- NÃO mexer (intencionalmente públicas pra authenticated):
--   - operadores, feature_flags, nf_chave_cte, ocorrencias_dicionario,
--     ocorrencias_dexpara, templates_email (metadata global; sem dado de cliente)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- cards_auditoria
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS cards_auditoria_select_auth ON public.cards_auditoria;

CREATE POLICY cards_auditoria_select_isolamento_operador
ON public.cards_auditoria
FOR SELECT
TO authenticated
USING (
  public.card_visivel_pelo_operador_atual(
    NULLIF(card_snapshot->>'assigned_operator_id', '')::uuid,
    cnpj_pagador,
    NULLIF(card_snapshot->>'segmento_codigo', '')
  )
);

-- ----------------------------------------------------------------------------
-- cards_emails_outbound — emails saindo pra cliente (subject, corpo)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS cards_emails_outbound_select_auth ON public.cards_emails_outbound;

CREATE POLICY cards_emails_outbound_select_isolamento_operador
ON public.cards_emails_outbound
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.cards c
    WHERE c.id = cards_emails_outbound.card_id
      AND public.card_visivel_pelo_operador_atual(
        c.assigned_operator_id, c.pagador, c.segmento_codigo
      )
  )
);

-- ----------------------------------------------------------------------------
-- email_anexos — anexos inbound e outbound (storage_path; filename pode conter PII)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS email_anexos_select_auth ON public.email_anexos;

CREATE POLICY email_anexos_select_isolamento_operador
ON public.email_anexos
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.cards c
    WHERE c.id = email_anexos.card_id
      AND public.card_visivel_pelo_operador_atual(
        c.assigned_operator_id, c.pagador, c.segmento_codigo
      )
  )
);

-- ----------------------------------------------------------------------------
-- Índices de suporte (JOIN cards via card_id) — provavelmente já existem,
-- mas garantindo (CREATE INDEX IF NOT EXISTS é idempotente)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS cards_emails_outbound_card_id_idx
  ON public.cards_emails_outbound (card_id);

CREATE INDEX IF NOT EXISTS email_anexos_card_id_idx
  ON public.email_anexos (card_id);

COMMENT ON POLICY cards_auditoria_select_isolamento_operador ON public.cards_auditoria IS
  'Operador só vê auditoria de cards seus (assigned_operator_id no snapshot OU '
  'cnpj_pagador na carteira). Gestor vê tudo. Fix 2026-05-18.';

COMMENT ON POLICY cards_emails_outbound_select_isolamento_operador ON public.cards_emails_outbound IS
  'Operador só vê emails enviados de cards seus (JOIN cards via card_id). '
  'Gestor vê tudo. Fix 2026-05-18.';

COMMENT ON POLICY email_anexos_select_isolamento_operador ON public.email_anexos IS
  'Operador só vê anexos de cards seus (JOIN cards via card_id). '
  'Gestor vê tudo. Fix 2026-05-18.';
