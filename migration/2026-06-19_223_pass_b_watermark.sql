-- =============================================================================
-- 2026-06-19_223_pass_b_watermark
--
-- Escala do Pass B (faxineiro) sem timeout. Hoje o Pass B re-confere TODOS os
-- cards ativos que saíram do pull do Pass A a cada ciclo (O(cards ativos)) →
-- ~100 chamadas ao Bastão/ciclo, cresce com a fila. Solução: watermark.
--
-- `pass_b_checked_at` = METADADO OPERACIONAL de scheduling do Pass B (igual a
-- bastao_synced_at da mig 005) — NÃO é estado de negócio do card, NÃO viola
-- event-sourcing: o release continua sendo evento em card_events
-- (releaseCard / fecharCardComoResolvidoFimDePendencia / releaseCardViaTracking).
--
-- O Pass B (atrás da flag PASS_B_WATERMARK_ENABLED) passa a:
--   SELECT ... WHERE <mesmos filtros> AND (pass_b_checked_at IS NULL OR
--          pass_b_checked_at < now() - interval '6 hours')
--   ORDER BY pass_b_checked_at NULLS FIRST LIMIT 150
-- → trabalho por ciclo fixo em O(150), independente do nº de cards ativos.
--
-- Índice PARCIAL com predicado IDÊNTICO ao SELECT do runPassB, pra o planner
-- usá-lo. NULLS FIRST no índice casa com o ORDER BY (card nunca checado primeiro).
-- CONCURRENTLY pra não travar `cards` (tabela quente — o sync escreve nela).
-- Coluna nasce NULL em todos → 1º ciclo idêntico ao Pass B atual (drena todos
-- via NULLS FIRST, 150/ciclo).
-- =============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS pass_b_checked_at timestamptz;

COMMENT ON COLUMN public.cards.pass_b_checked_at IS
  'Watermark do Pass B (sync-bastao): última vez que o faxineiro conferiu se o card saiu do escopo de relacionamento. Metadado de scheduling, NÃO estado de negócio. NULL = nunca checado (entra primeiro). Zerado em toda reabertura/reativação.';

-- CONCURRENTLY não pode rodar em transação — psql -f roda autocommit por statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cards_passb_due
  ON public.cards (pass_b_checked_at NULLS FIRST)
  WHERE bastao_pendencia_id IS NOT NULL
    AND nf IS NOT NULL
    AND state NOT IN ('RESOLVIDO','CANCELADO','TRANSFERIDO','TRATATIVA_PENDENTE','ACAO_EXECUTADA','EXTRAVIO_MONITORADO');
