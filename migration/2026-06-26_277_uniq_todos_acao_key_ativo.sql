-- =============================================================================
-- 2026-06-26_277 — Índice único: 1 todo ATIVO por (card, acao_key).
--
-- Caio 2026-06-26: a lista de "ações sugeridas" mostrava a MESMA ação repetida
-- (ex.: "Lançar 54 + e-mail" 2×/6×, "54 sem e-mail" 5×, oc 49 duplicada). Causa:
-- vários fluxos criam todos (proporAutoAcao em sync-bastao/vinculador/atualizar-
-- card-via-portal/agente-ocs-padrao/backfill, garantirOpcaoLancarSemEmail,
-- ressarcimento, re-lançar 54) e a dedup por código no app não cobre todos os
-- caminhos nem corrida — ao longo de dias o mesmo card acumula cópias da mesma
-- ação. Escopo achado: 70 todos duplicados em 48 cards (deduplicados antes desta
-- migration, mantendo 1 por acao_key: aprovado > com-e-mail > mais recente).
--
-- Fix de RAIZ (não-recorrência): índice único PARCIAL garante, no banco, no máx
-- 1 todo ATIVO (pendente/aprovado) por (card_id, acao_key). Qualquer caminho que
-- tente inserir a 2ª falha com unique_violation — e os inserts de proposta já
-- tratam erro graciosamente (console.error + continue / ok:false), virando no-op
-- idempotente. Todos sem acao_key (texto livre, sem codigo_ssw) não são afetados.
-- Guard: verify-cockpit INV-030.
-- =============================================================================

-- CONCURRENTLY (fora de transação): não trava a tabela quente `todos`.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_todos_card_acao_key_ativo
  ON public.todos (card_id, (proposta_payload->>'acao_key'))
  WHERE status IN ('pendente', 'aprovado')
    AND (proposta_payload->>'acao_key') IS NOT NULL;

COMMENT ON INDEX public.uniq_todos_card_acao_key_ativo IS
  'No máx 1 todo ATIVO por (card_id, acao_key) — impede opções duplicadas na '
  'lista de ações. Caio 2026-06-26 (dedup 70 todos/48 cards). INV-030.';
