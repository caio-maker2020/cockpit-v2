-- =============================================================================
-- 2026-09-14_392 — sombra Haiku×Sonnet no triador (Caio 14/09, roda 1 dia)
-- =============================================================================
-- Ordem do Caio 14/09: "pode ligar a sombra mas apenas por um dia... se não
-- [houver diferença], já mudamos amanhã pro fim do dia". O triador roda Sonnet
-- (violando a convenção nº 7 — Haiku pra triagem) e é a maior fatia da conta.
-- A sombra grava o par Sonnet(real)×Haiku(paralelo) por mensagem; veredito
-- 15/09 fim do dia: ≥95% tipo e ≥98% NFs → troca o TRIADOR_MODEL.
-- Flag NASCE ON por ordem expressa (a janela é amanhã). TIPO A. Sem BEGIN.
-- skill: supabase-postgres-best-practices aplicada.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.triador_sombra_haiku (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid NOT NULL,
  tipo_sonnet   text NOT NULL,
  tipo_haiku    text NOT NULL,
  risco_sonnet  text,
  risco_haiku   text,
  nfs_sonnet    text[] NOT NULL DEFAULT '{}',
  nfs_haiku     text[] NOT NULL DEFAULT '{}',
  ctrcs_sonnet  text[] NOT NULL DEFAULT '{}',
  ctrcs_haiku   text[] NOT NULL DEFAULT '{}',
  diverge_tipo  boolean NOT NULL,
  diverge_risco boolean NOT NULL,
  diverge_nfs   boolean NOT NULL,
  diverge_ctrcs boolean NOT NULL,
  diverge       boolean NOT NULL,
  erro_haiku    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.triador_sombra_haiku ENABLE ROW LEVEL SECURITY;
-- leitura pros logados (auditoria); escrita só service_role (edge)
DROP POLICY IF EXISTS triador_sombra_select ON public.triador_sombra_haiku;
CREATE POLICY triador_sombra_select ON public.triador_sombra_haiku
  FOR SELECT TO authenticated USING (true);
CREATE INDEX IF NOT EXISTS idx_triador_sombra_created
  ON public.triador_sombra_haiku (created_at);

INSERT INTO public.feature_flags (key, enabled, description)
VALUES ('triador_sombra_haiku_enabled', true,
        'Sombra Haiku 4.5 no triador (Caio 14/09, janela de 1 dia — 15/09). Decisão real segue Sonnet; par gravado em triador_sombra_haiku. Desligar após o veredito.')
ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, description = EXCLUDED.description;
