-- ============================================================================
-- Cockpit v2 — finalize_import_chaves_cte com DELETE em chunks
-- Data: 2026-05-07
--
-- Bug Caio 2026-05-07 (relatório do sócio): finalize do import OPC 455
-- estoura statement_timeout (PostgREST default ~8s) quando precisa apagar
-- 10k+ rows de sessões antigas. Logs:
--   "POST falhou após 3 tentativas: server 500: canceling statement due to
--    statement timeout"
-- Resultado: tabela fica com sessions duplicadas (nova + velha) e nfs podem
-- pegar chave de session antiga (errada) no lookup.
--
-- Causa raiz:
--   1. DELETE único em ~10-670k rows estoura timeout do gateway HTTP.
--   2. Índice em import_session é parcial (WHERE IS NOT NULL); planner não
--      usa pra DELETE com `IS DISTINCT FROM`.
--
-- Fix:
--   1. Recria índice cheio em import_session (planner usa em equality).
--   2. RPC bypassa statement_timeout localmente + apaga em chunks de 50k.
--      Cada chunk é um statement separado dentro da função.
-- ============================================================================

-- 1. Índice cheio em import_session pra acelerar lookup do que apagar.
DROP INDEX IF EXISTS public.idx_nf_chave_cte_import_session;

CREATE INDEX IF NOT EXISTS idx_nf_chave_cte_import_session
  ON public.nf_chave_cte (import_session);

COMMENT ON INDEX public.idx_nf_chave_cte_import_session IS
  'Caio 2026-05-07: índice cheio (não parcial) — finalize delete por '
  'session usa scan rápido; também acelera análises de auditoria.';

-- 2. RPC com chunked delete + bypass de statement_timeout.
CREATE OR REPLACE FUNCTION public.finalize_import_chaves_cte(
  p_current_session text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted_total bigint := 0;
  v_chunk bigint;
  v_kept bigint;
  v_chunk_size constant int := 50000;
  v_max_iterations constant int := 200; -- segurança: 200 * 50k = 10M rows
  v_iter int := 0;
BEGIN
  IF p_current_session IS NULL OR length(trim(p_current_session)) = 0 THEN
    RAISE EXCEPTION 'session id obrigatório';
  END IF;

  -- Caio 2026-05-07: bypass do statement_timeout do PostgREST (default 8s).
  -- Cada chunk de 50k rows leva ~3-5s; com 670k rows são até 70s totais.
  -- Mantém local pro escopo da função; outras queries do role seguem com
  -- o timeout normal.
  PERFORM set_config('statement_timeout', '0', true);

  -- Chunked delete. Cada iteração apaga até 50k rows; LOOP até zerar.
  -- Usa ctid pra evitar re-escanear o índice em cada iteração.
  LOOP
    v_iter := v_iter + 1;
    EXIT WHEN v_iter > v_max_iterations;

    WITH alvo AS (
      SELECT ctid
      FROM public.nf_chave_cte
      WHERE import_session IS DISTINCT FROM p_current_session
      LIMIT v_chunk_size
    ),
    del AS (
      DELETE FROM public.nf_chave_cte
      WHERE ctid IN (SELECT ctid FROM alvo)
      RETURNING 1
    )
    SELECT count(*) INTO v_chunk FROM del;

    v_deleted_total := v_deleted_total + v_chunk;
    EXIT WHEN v_chunk = 0;
  END LOOP;

  IF v_iter > v_max_iterations AND v_chunk > 0 THEN
    RAISE EXCEPTION 'finalize abortado: > % iterações de %k rows. Possível loop infinito.',
      v_max_iterations, v_chunk_size / 1000;
  END IF;

  SELECT count(*) INTO v_kept
  FROM public.nf_chave_cte
  WHERE import_session = p_current_session;

  RETURN jsonb_build_object(
    'session', p_current_session,
    'deleted_old_sessions', v_deleted_total,
    'kept_current_session', v_kept,
    'chunks_processed', v_iter,
    'chunk_size', v_chunk_size,
    'finalized_at', now()
  );
END;
$$;

COMMENT ON FUNCTION public.finalize_import_chaves_cte(text) IS
  'Caio 2026-05-07: chunked delete (50k rows/chunk) + bypass statement_timeout. '
  'Bug raiz era DELETE único em 10k-670k rows estourando timeout do PostgREST (8s).';

REVOKE ALL ON FUNCTION public.finalize_import_chaves_cte(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_import_chaves_cte(text) TO service_role;
