-- ============================================================================
-- Cockpit v2 — analises_prioridades_ai (cache outputs Sonnet 4.6)
-- Data: 2026-05-19
--
-- Cache das análises dos 2 agentes IA (PRIORIDADES AI):
--   - tipo='priorizador' → ranking + observação por card (12h TTL)
--   - tipo='monitor'     → veredito + próxima ação por card cobrado (6h TTL)
--
-- View v_prioridades_ai LÊ a análise mais recente por card (sem filtrar tipo;
-- o front discrimina via colunas rank_priorizador vs veredito_monitor).
-- ============================================================================

CREATE TABLE public.analises_prioridades_ai (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('priorizador','monitor')),
  -- Priorizador
  rank_priorizador int,                        -- 1..N dentro do operador
  observacao_priorizador text,                 -- "Cooperativa já atrasou 3× em 60d"
  -- Monitor
  veredito_monitor text CHECK (veredito_monitor IS NULL OR veredito_monitor IN (
    'efetiva','parcial','sem_resposta','sair_kanban')),
  proxima_acao_monitor text,                   -- "Escalar pra coordenador"
  -- Comum
  modelo text DEFAULT 'claude-sonnet-4-6',
  tokens_input int,
  tokens_output int,
  payload_completo jsonb,                      -- response raw da IA (debug)
  analisado_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL
);

CREATE INDEX idx_analises_card_tipo_analisado
  ON public.analises_prioridades_ai (card_id, tipo, analisado_em DESC);
CREATE INDEX idx_analises_tipo_expira
  ON public.analises_prioridades_ai (tipo, expira_em);

ALTER TABLE public.analises_prioridades_ai ENABLE ROW LEVEL SECURITY;

CREATE POLICY analises_select
  ON public.analises_prioridades_ai
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = analises_prioridades_ai.card_id
        AND public.card_visivel_pelo_operador_atual(
          c.assigned_operator_id, c.pagador, c.segmento_codigo)
    )
  );

COMMENT ON TABLE public.analises_prioridades_ai IS
  'Cache dos outputs dos 2 agentes Sonnet 4.6 (Priorizador + Monitor). '
  'Priorizador TTL 12h, Monitor TTL 6h. View v_prioridades_ai lê o mais recente.';
