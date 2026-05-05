-- ============================================================================
-- Cockpit v2 — Tabela de versionamento de migrations
-- Data: 2026-05-01
--
-- Antes: SQL aplicado via Management API direto, sem rastreamento.
-- Agora: cada arquivo migration/*.sql é registrado aqui após aplicação.
--
-- Coluna sha256 detecta drift: se alguém editou uma migration antiga após
-- aplicada, o script `scripts/apply_migrations.py` vai recusar próximas
-- aplicações até a inconsistência ser resolvida.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename    text PRIMARY KEY,
  sha256      text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL DEFAULT 'manual',
  duration_ms integer
);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
  ON public.schema_migrations(applied_at DESC);

COMMENT ON TABLE public.schema_migrations IS
  'Rastreia quais arquivos migration/*.sql já foram aplicados. Sha256 do conteúdo '
  'permite detectar edição posterior à aplicação (drift). Populado pelo script '
  'scripts/apply_migrations.py.';

-- ============================================================================
-- RLS: só service_role mexe; ninguém mais lê (info sensível)
-- ============================================================================
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
-- Sem policy = ninguém acessa via RLS (service_role bypassa)
