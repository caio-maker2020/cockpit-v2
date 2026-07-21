-- =============================================================================
-- 2026-07-21_302 — Auto-encaminhamento de resposta pra caixa do NOVO dono
-- =============================================================================
-- Caio 2026-07-21 (onboarding Karoline): quando um card é reatribuído, a resposta
-- do cliente cai na caixa Gmail do dono ANTIGO. O Cockpit já cola no card do novo
-- dono; esta feature encaminha uma CÓPIA pra caixa Gmail do novo dono também.
-- Lógica em _shared/encaminhar-email-reatribuido.ts (chamada blindada no
-- gmail-poll-inbox). Envio pela conta que capturou (gmail.send já existente —
-- SEM escopo novo).
--
-- Cria: (1) tabela de idempotência; (2) feature flag (ligada).
-- skill: supabase-postgres-best-practices — idempotente (IF NOT EXISTS / ON
-- CONFLICT), RLS habilitada com service_role-only (menor privilégio), UNIQUE
-- gera índice pro lookup de dedup.
-- =============================================================================
BEGIN;

-- 1. Idempotência do encaminhamento (1 cópia por mensagem x destino)
CREATE TABLE IF NOT EXISTS public.emails_encaminhados_operador (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id  text NOT NULL,
  para_email        text NOT NULL,
  card_id           uuid REFERENCES public.cards(id)      ON DELETE SET NULL,
  de_operador_id    uuid REFERENCES public.operadores(id) ON DELETE SET NULL,
  para_operador_id  uuid REFERENCES public.operadores(id) ON DELETE SET NULL,
  enviado_em        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_email_encaminhado UNIQUE (gmail_message_id, para_email)
);

COMMENT ON TABLE public.emails_encaminhados_operador IS
  'Idempotência do auto-encaminhamento de resposta do cliente pra caixa do novo '
  'dono de um card reatribuído. INSERT reserva antes do envio; conflito = já '
  'encaminhado. Caio 2026-07-21 (onboarding Karoline). Ver _shared/encaminhar-email-reatribuido.ts.';

-- RLS: só service_role (edge functions) escreve/lê. Sem policy p/ authenticated
-- = deny por padrão (menor privilégio; nenhum operador precisa ler isto).
ALTER TABLE public.emails_encaminhados_operador ENABLE ROW LEVEL SECURITY;

-- 2. Feature flag (ligada — Caio aprovou 2026-07-21)
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'email_forward_reatribuido_ativo',
  true,
  'Encaminha cópia da resposta do cliente pra caixa Gmail do NOVO dono quando o card foi reatribuído (thread vive na caixa do dono antigo). Caio 2026-07-21 onboarding Karoline. Desligável em 1 clique.'
)
ON CONFLICT (key) DO UPDATE SET
  enabled     = EXCLUDED.enabled,
  description = EXCLUDED.description,
  updated_at  = now();

COMMIT;
