-- ============================================================================
-- Cockpit v2 — colunas tracking do agente-oc13-autonomo
-- Caio 2026-05-22
--
-- O agente IA precisa de campos pra:
--   * status (pendente/analisando/concluida/falhou)
--   * resultado completo da decisão (jsonb)
--   * contagem de tentativas (retry max 3x via cron 10min)
--   * timestamp pra controle de retry e cache
--
-- skill: supabase-postgres-best-practices
--   * IF NOT EXISTS pra idempotência
--   * CHECK constraint cobrindo NULL (estado inicial)
--   * Index parcial pro cron (varre só pendente/falhou + oc=13)
-- ============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS analise_oc13_status text
    CHECK (analise_oc13_status IS NULL OR analise_oc13_status IN ('pendente','analisando','concluida','falhou')),
  ADD COLUMN IF NOT EXISTS analise_oc13_resultado jsonb,
  ADD COLUMN IF NOT EXISTS analise_oc13_tentativas int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS analise_oc13_atualizado_em timestamptz;

COMMENT ON COLUMN public.cards.analise_oc13_status IS
  'Status do agente-oc13-autonomo. NULL=ainda não analisado. '
  'pendente/analisando/concluida/falhou. Caio 2026-05-22.';
COMMENT ON COLUMN public.cards.analise_oc13_resultado IS
  'Resultado JSON da árvore de decisão: {decisao:autonoma|sugerir_54_email|operador_antecipou, '
  'subtipo, motivo_extraido, motivo_cancelamento, foto_classificacao, confianca, template_email}';

CREATE INDEX IF NOT EXISTS idx_cards_analise_oc13_pendente
  ON public.cards (analise_oc13_atualizado_em NULLS FIRST)
  WHERE cod_ultima_ocorrencia = 13
    AND (analise_oc13_status IS NULL OR analise_oc13_status IN ('pendente','falhou','analisando'));
