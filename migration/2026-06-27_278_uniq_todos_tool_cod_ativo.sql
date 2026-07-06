-- =============================================================================
-- 2026-06-27_278 — Índice único UNIVERSAL contra opções duplicadas: 1 todo ATIVO
--                  por (card, tool, codigo_ssw) — substitui o índice por acao_key.
--
-- Caio 2026-06-27 (NF 5948): o índice anterior (uniq_todos_card_acao_key_ativo,
-- mig 277) só cobria todos COM `acao_key`. Mas fluxos como o de extravio
-- (origem=extravio_cockpit) criam todos SEM acao_key → escapavam do dedup E do
-- índice → continuavam duplicando (5948 acumulou 49/54/55 a cada ciclo 06-17/18/22).
--
-- Fix: a identidade da ação vem do PAYLOAD sempre presente — `tool` + `codigo_ssw`
-- (= o mesmo que acao_key "tool:cod", mas computado, então funciona mesmo quando
-- o campo acao_key não foi carimbado). coalesce(cod,'') faz os "notificar sem
-- lançar oc" (cod nulo) deduplicarem entre si. Todos sem `tool` (texto livre) não
-- são afetados. Dedup retroativo por tool+cod já rodado (69 todos / 64 cards, +70
-- da mig 277). Guard: verify-cockpit INV-030.
-- =============================================================================

DROP INDEX CONCURRENTLY IF EXISTS public.uniq_todos_card_acao_key_ativo;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_todos_card_tool_cod_ativo
  ON public.todos (
       card_id,
       (proposta_payload->>'tool'),
       coalesce((proposta_payload->'args'->>'codigo_ssw'), '')
     )
  WHERE status IN ('pendente', 'aprovado')
    AND (proposta_payload->>'tool') IS NOT NULL;

COMMENT ON INDEX public.uniq_todos_card_tool_cod_ativo IS
  'No máx 1 todo ATIVO por (card_id, tool, codigo_ssw) — impede opções duplicadas '
  'na lista de ações, inclusive todos sem acao_key (extravio_cockpit). Caio '
  '2026-06-27 (NF 5948). Substitui uniq_todos_card_acao_key_ativo. INV-030.';
