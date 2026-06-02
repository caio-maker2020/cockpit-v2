-- ============================================================================
-- Cockpit v2 — alívio Disk IO: drop índices inúteis em nf_chave_cte
-- Caio 2026-06-01
--
-- CONTEXTO: Supabase enviou novo aviso de Disk IO Budget depleting (2026-06-01).
-- Análise via pg_stat_user_indexes revelou 4 índices em nf_chave_cte (472 MB,
-- 691k linhas, alvo de INSERTs massivos do RPA OPC 455) que nunca ou quase
-- nunca são usados, mas oneram cada INSERT:
--
--   idx_nf_chave_cte_emissor_sal | 43 MB | 0 scans lifetime (mig 164 revertida)
--   idx_nf_chave_cte_emissor     | 15 MB | 0 scans lifetime (mig 164 revertida)
--   idx_nf_chave_cte_ctrc        | 42 MB | 6 scans lifetime
--   idx_nf_chave_cte_imported_at | 13 MB | 2 scans lifetime
--
-- Os índices `_emissor*` foram criados pela mig 164 e mantidos "por garantia"
-- na mig 165 (revert). Confirmado: nenhum caller os usa. Removendo todos os 4,
-- INSERT em nf_chave_cte deixa de atualizar 4 b-trees → ~44% menos IO de write
-- por chave importada.
--
-- skill: supabase-postgres-best-practices
--   * CONCURRENTLY: sem AccessExclusiveLock, seguro em produção
--   * Cada DROP precisa rodar fora de transação (CONCURRENTLY incompatível com BEGIN)
--   * Aplicação: psql separa cada statement com \; e -1 OFF, ou roda 4 vezes
--
-- Riscos: zero pros _emissor* (nunca usados). Mínimo pros outros 2 (recriar em
-- <1min se algum query futuro precisar; pkey + idx_nf_chave_cte_nf_pagador
-- cobrem 99% dos lookups).
--
-- Verificação pós-aplicação:
--   SELECT indexrelname, idx_scan FROM pg_stat_user_indexes
--   WHERE relname='nf_chave_cte';
-- ============================================================================

DROP INDEX CONCURRENTLY IF EXISTS public.idx_nf_chave_cte_emissor_sal;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_nf_chave_cte_emissor;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_nf_chave_cte_ctrc;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_nf_chave_cte_imported_at;
