-- ============================================================================
-- Cockpit v2 — RPC upsert_chaves_cte_bulk: UPSERT bulk com statement_timeout=0
-- Caio 2026-06-05
--
-- CONTEXTO: RPA OPC 455 rodou em 24min (dentro do timeout Python de 30min),
-- MAS 186 batches resultaram em ERROS perdendo ~184k chaves (de 687k esperadas,
-- só 497k inseriram). Python pulou finalize (proteção).
--
-- Diagnóstico via pg_stat_statements:
--   - INSERT do PostgREST: 37k calls, mean 926ms, MAX 7985ms (~8s exatos)
--   - Bate com statement_timeout=8s do role authenticator do Supabase
--   - 186 batches que excederam 8s foram cancelados (mesma causa raiz da mig 190)
--
-- Mesma estratégia da mig 190 (finalize_import_chaves_cte): criar RPC interna
-- com ALTER FUNCTION SET statement_timeout='0' aplicado NO MOMENTO da invocação.
--
-- skill: supabase-postgres-best-practices
--   * SECURITY DEFINER pra rodar como dono (postgres) sem herdar timeout do role chamador
--   * SET statement_timeout='0' + lock_timeout='60s' no nível da função
--   * jsonb_to_recordset pra deserializar batch (mesma pattern do PostgREST interno)
--   * ON CONFLICT idêntico ao comportamento atual da edge
--   * Retorna inserted_count pra edge somar — match com response existente
--
-- Caso âncora: log 2026-06-05T11:12 — 686 batches, 186 errors, status partial.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.upsert_chaves_cte_bulk(p_rows jsonb)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count int := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.nf_chave_cte (
    chave_cte, nf, cnpj_pagador, ctrc, data_emissao, import_session
  )
  SELECT
    r.chave_cte, r.nf, r.cnpj_pagador, r.ctrc, r.data_emissao, r.import_session
  FROM jsonb_to_recordset(p_rows) AS r(
    chave_cte text,
    nf text,
    cnpj_pagador text,
    ctrc text,
    data_emissao date,
    import_session text
  )
  ON CONFLICT (chave_cte) DO UPDATE SET
    nf = EXCLUDED.nf,
    cnpj_pagador = EXCLUDED.cnpj_pagador,
    ctrc = EXCLUDED.ctrc,
    data_emissao = EXCLUDED.data_emissao,
    import_session = EXCLUDED.import_session;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- Aplica timeout=0 NO NÍVEL DA FUNÇÃO (não confiar em set_config interno —
-- via PostgREST o authenticator cancela antes do plpgsql rodar)
ALTER FUNCTION public.upsert_chaves_cte_bulk(jsonb)
  SET statement_timeout = '0';

ALTER FUNCTION public.upsert_chaves_cte_bulk(jsonb)
  SET lock_timeout = '60s';

-- GRANT pra service_role chamar via PostgREST RPC
GRANT EXECUTE ON FUNCTION public.upsert_chaves_cte_bulk(jsonb) TO service_role;

COMMENT ON FUNCTION public.upsert_chaves_cte_bulk(jsonb) IS
  'Caio 2026-06-05: UPSERT bulk em nf_chave_cte com statement_timeout=0 pra '
  'contornar authenticator timeout de 8s no Supabase. Usado pela edge '
  'import-chaves-cte que estava perdendo ~25% das chaves quando batches '
  'demoravam >8s (caso 2026-06-05: 186 batches falharam).';
