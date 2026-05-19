-- ============================================================================
-- Cockpit v2 — cards.prioridades_kanban_status (PRIORIDADES AI)
-- Data: 2026-05-19
--
-- Coluna cacheada com a posição do card no kanban PRIORIDADES AI.
-- Valores possíveis (NULL = não está no kanban):
--   'parada'    → última oc=13/21, sem cobrança via Cockpit
--   'cobrado'   → 1ª cobrança disparada pra gerente_base
--   'escalado'  → cobrança disparada pra coordenador OU gerente_relacionamento
--   'resolvido' → oc=14 OU finalizadora (01/30/32) detectada
--
-- Quem escreve:
--   - disparar-cobranca-escalonada: parada/NULL → cobrado/escalado
--   - agente-monitor-efetividade-ai: cobrado/escalado → resolvido (se oc=14
--     ou finalizadora); → NULL (se nova oc de relacionamento — sai do kanban)
--   - sync-kanban-status-prioridades: cards novos em v_oc*_paradas com NULL → parada
--
-- prioridades_kanban_atualizado_em: timestamp da última transição (audit).
-- ============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS prioridades_kanban_status text
    CHECK (prioridades_kanban_status IS NULL
           OR prioridades_kanban_status IN ('parada','cobrado','escalado','resolvido')),
  ADD COLUMN IF NOT EXISTS prioridades_kanban_atualizado_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_cards_prioridades_kanban_status
  ON public.cards (prioridades_kanban_status)
  WHERE prioridades_kanban_status IS NOT NULL;

COMMENT ON COLUMN public.cards.prioridades_kanban_status IS
  'Posição do card no kanban PRIORIDADES AI. NULL = não está no kanban. '
  'Escrita por disparar-cobranca-escalonada, agente-monitor-efetividade-ai, '
  'sync-kanban-status-prioridades. Migration 126.';

COMMENT ON COLUMN public.cards.prioridades_kanban_atualizado_em IS
  'Timestamp da última transição de prioridades_kanban_status.';
