-- =============================================================================
-- 2026-09-14_390 — monitor de capacidade: fim do 500 na primeira abertura
-- =============================================================================
-- Caso real (Caio 14/09): monitor não carregava — "erro ao carregar Anthropic:
-- HTTP 500" (rótulo errado do front; o culpado era acoes_negocio_periodo).
-- Diagnóstico medido: default 30d → 500 após ~3,2s com banco frio; depois de
-- aquecido, 0,35s. EXPLAIN: Index Only Scan degradado — 13.769 páginas lidas
-- do DISCO pra 28k linhas (5,9s frio). Raiz dupla:
--   (a) card_events (1,19M linhas, append-only) sem vacuum desde 20/08 —
--       tabela que só insere quase não dispara autovacuum por dead tuples, o
--       visibility map envelhece e todo index-only scan vira heap fetch;
--   (b) a query da RPC precisa de card_id + payload->>'state_novo', que não
--       estão em índice nenhum — mesmo com visibility ok haveria heap fetch.
-- Fix na raiz, mesma classe do INV-090 (timeout × consulta de painel):
--   1. índice PARCIAL cobrindo exatamente a consulta do monitor (só os 8
--      event_types dela; created_at na frente pro range; expressão do payload
--      como coluna de chave — INCLUDE não aceita expressão);
--   2. autovacuum por INSERTS agressivo pra card_events (append-only): a cada
--      ~50k inserts em vez do default (~120k), mantendo o visibility map vivo;
--   3. VACUUM ANALYZE imediato (atualiza o mapa já — o CONCURRENTLY e o VACUUM
--      não podem rodar em transação: aplicar via dbq SEM --dry-run).
-- TIPO A (aditivo/reversível). Sem BEGIN/COMMIT (obrigatório aqui).
-- skill: supabase-postgres-best-practices aplicada.
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_card_events_monitor_negocio
  ON public.card_events (created_at, event_type, card_id, (payload->>'state_novo'))
  WHERE event_type IN ('AcaoExecutada','AcaoExecutadaPortal','RespostaEnviada',
                       'RespostaManualEnviadaPeloCockpit','CardResolvidoBastaoFimDePendencia',
                       'AcaoExecutadaConfirmadaPeloSsw','AtualizadoViaPortalSsw','DevolvidoParaSetor');

ALTER TABLE public.card_events SET (
  autovacuum_vacuum_insert_threshold = 50000,
  autovacuum_vacuum_insert_scale_factor = 0
);

VACUUM (ANALYZE) public.card_events;
