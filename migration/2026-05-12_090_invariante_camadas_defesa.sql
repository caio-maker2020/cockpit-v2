-- =============================================================================
-- 2026-05-12_090 — Camadas 3, 4, 5c e 6 do plano "invariante NF de
-- relacionamento sempre no Cockpit".
--
-- Tabelas:
--   sync_errors           — persistência dos errors[] do sync-bastao (Camada 3)
--   alerts                — banner pro Caio quando algo extraordinário (Camada 3)
--   invariante_violacoes  — diff Bastão vs Cockpit (Camada 4, auditoria)
--   sync_runs             — telemetria por execução do sync (Camada 6)
--
-- Coluna nova:
--   operadores.cockpit_ativo — substitui hardcode BASTAO_TEST_FILTER_OPERATOR
--     (Camada 5c). True hoje só pra Larissa; quando subir outro operador,
--     basta UPDATE.
-- =============================================================================

-- Camada 3: sync_errors
CREATE TABLE IF NOT EXISTS public.sync_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass text NOT NULL,
  ref text NOT NULL,
  nf text,
  message text NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_errors_unresolved_idx
  ON public.sync_errors (created_at DESC) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS sync_errors_nf_idx
  ON public.sync_errors (nf) WHERE resolved_at IS NULL;

-- Camada 3: alerts (banner pro front)
CREATE TABLE IF NOT EXISTS public.alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL,
  mensagem text NOT NULL,
  severidade text NOT NULL DEFAULT 'warning' CHECK (severidade IN ('info','warning','error')),
  metadata jsonb DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alerts_unresolved_idx
  ON public.alerts (created_at DESC) WHERE resolved_at IS NULL;

-- Camada 4: invariante_violacoes
CREATE TABLE IF NOT EXISTS public.invariante_violacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_violacao text NOT NULL CHECK (tipo_violacao IN ('card_ausente','oc_divergente','state_invalido')),
  nf text NOT NULL,
  oc_bastao integer NOT NULL,
  oc_cockpit integer,
  state_cockpit text,
  responsavel_relacionamento text,
  detalhes jsonb DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS invariante_violacoes_nf_open_uq
  ON public.invariante_violacoes (nf) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS invariante_violacoes_detected_idx
  ON public.invariante_violacoes (detected_at DESC);

-- Camada 6: sync_runs (telemetria)
CREATE TABLE IF NOT EXISTS public.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  summary jsonb,
  errors_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed'))
);

CREATE INDEX IF NOT EXISTS sync_runs_started_idx
  ON public.sync_runs (started_at DESC);

-- Camada 5c: cockpit_ativo em operadores
ALTER TABLE public.operadores
  ADD COLUMN IF NOT EXISTS cockpit_ativo boolean NOT NULL DEFAULT false;

-- Hoje só Larissa está em produção (test filter atual = "LARISSA").
UPDATE public.operadores SET cockpit_ativo = true WHERE upper(nome) = 'LARISSA' AND ativo = true;

COMMENT ON COLUMN public.operadores.cockpit_ativo IS
  'Quando true, sync-bastao puxa pendências cujo responsavel_relacionamento bate com este operador. Substitui o hardcode BASTAO_TEST_FILTER_OPERATOR. Setar manualmente quando subir cada novo operador no Cockpit.';

-- View de conveniência pro front (Camada 4 e 6)
CREATE OR REPLACE VIEW public.vw_invariante_status AS
SELECT
  (SELECT count(*) FROM public.invariante_violacoes WHERE resolved_at IS NULL) AS violacoes_abertas,
  (SELECT count(*) FROM public.sync_errors WHERE resolved_at IS NULL) AS sync_errors_abertos,
  (SELECT count(*) FROM public.alerts WHERE resolved_at IS NULL) AS alerts_abertos,
  (SELECT max(started_at) FROM public.sync_runs WHERE status='succeeded') AS ultimo_sync_sucesso,
  (SELECT max(started_at) FROM public.sync_runs) AS ultimo_sync_qualquer;

GRANT SELECT ON public.vw_invariante_status TO anon, authenticated;
