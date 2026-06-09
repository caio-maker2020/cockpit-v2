-- ============================================================================
-- Cockpit v2 — DROP destrutivo da infra de chave_cte e ocorrencias_dexpara
-- Caio 2026-06-09
--
-- Contexto: migração 100% pra portal interno SSW (opção 101). Hot loop de
-- UPDATEs em nf_chave_cte (36M acumulados via RPA OPC 455) era o hotspot
-- principal do Disk IO. Portal usa card.ctrc + buscarNFInterno — não precisa
-- nem da tabela nem do RPA.
--
-- Estratégia "destrutiva inteligente":
--   1. DROP tabelas pesadas: nf_chave_cte (370MB + 4 índices 220MB) e
--      ocorrencias_dexpara. Cleanup de espaço imediato.
--   2. Substituir RPCs (lookup_chave_cte, lookup_codigo_api, etc.) por STUBS
--      NO-OP que sempre retornam vazio. Código não-refatorado (regras-auto-
--      acao caminhos sec., vinculador thread, health-check) recebe null,
--      degrada graciosamente sem erro 404 de "function does not exist".
--   3. UPDATE all cards SET sem_chave_cte = false — gate em aprovar_e_executar
--      fica vivo mas nunca dispara (todos os cards têm flag false). Evita
--      mexer no corpo complexo da RPC.
--   4. Pass A do sync-bastao + vinculador já neutralizados em código pra não
--      setar sem_chave_cte=true em cards novos.
--
-- Cleanup completo (drop stubs + coluna sem_chave_cte + gate na RPC +
-- arquivos _shared/chave-cte-*.ts) fica pra mig 196 após 24h de validação.
--
-- Backup pré-mig em ./backup_pre_mig_195/ (csv ocorrencias_dexpara + stats).
--
-- skill: supabase-postgres-best-practices
--   * DROP CASCADE controlado — dependências contadas
--   * Stubs em SECURITY DEFINER + search_path=public (mesmo padrão dos originais)
--   * GRANT EXECUTE explícito pra authenticated + service_role
--   * UPDATE em massa de cards.sem_chave_cte: usa filter WHERE pra evitar
--     reescrita full do heap
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'mig 195 destrutiva iniciando. Backup em ./backup_pre_mig_195/';
END $$;

-- =============================================================================
-- 1. Zera flag sem_chave_cte em todos os cards ativos
--    Gate em aprovar_e_executar fica vivo mas nunca dispara.
-- =============================================================================

UPDATE public.cards
SET sem_chave_cte = false
WHERE sem_chave_cte = true;

-- =============================================================================
-- 2. STUBS no-op pras RPCs de lookup chave_cte / dexpara
--    Substituem RPCs originais. Sempre retornam vazio/null.
-- =============================================================================

-- 2.1 lookup_chave_cte(p_nf, p_cnpj_pagador, p_ctrc) — retorna 0 rows
DROP FUNCTION IF EXISTS public.lookup_chave_cte(text, text, text);
DROP FUNCTION IF EXISTS public.lookup_chave_cte(text, text);
CREATE FUNCTION public.lookup_chave_cte(
  p_nf text,
  p_cnpj_pagador text DEFAULT NULL,
  p_ctrc text DEFAULT NULL
) RETURNS TABLE(chave_cte text, ctrc text, data_emissao date, tipo_documento text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULL::text, NULL::text, NULL::date, NULL::text WHERE false;
$$;
COMMENT ON FUNCTION public.lookup_chave_cte(text, text, text) IS
  'STUB no-op Caio 2026-06-09 mig 195: tabela nf_chave_cte dropada. Sempre retorna vazio.';
GRANT EXECUTE ON FUNCTION public.lookup_chave_cte(text, text, text) TO authenticated, service_role;

-- 2.2 lookup_chaves_cte_alternativas(p_nf, p_cnpj_pagador, p_chave_excluir, p_ctrc)
DROP FUNCTION IF EXISTS public.lookup_chaves_cte_alternativas(text, text, text, text);
CREATE FUNCTION public.lookup_chaves_cte_alternativas(
  p_nf text,
  p_cnpj_pagador text DEFAULT NULL,
  p_chave_excluir text DEFAULT NULL,
  p_ctrc text DEFAULT NULL
) RETURNS TABLE(chave_cte text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULL::text WHERE false;
$$;
COMMENT ON FUNCTION public.lookup_chaves_cte_alternativas(text, text, text, text) IS
  'STUB no-op Caio 2026-06-09 mig 195.';
GRANT EXECUTE ON FUNCTION public.lookup_chaves_cte_alternativas(text, text, text, text) TO authenticated, service_role;

-- 2.3 lookup_codigo_api(p_codigo_ssw int) → retorna o próprio código
--     Portal usa semântico direto. Stub defensivo pra callers legados.
DROP FUNCTION IF EXISTS public.lookup_codigo_api(int);
CREATE FUNCTION public.lookup_codigo_api(p_codigo_ssw int)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_codigo_ssw;
$$;
COMMENT ON FUNCTION public.lookup_codigo_api(int) IS
  'STUB Caio 2026-06-09 mig 195: ocorrencias_dexpara dropada. Retorna p_codigo_ssw direto (portal não precisa wire).';
GRANT EXECUTE ON FUNCTION public.lookup_codigo_api(int) TO authenticated, service_role;

-- =============================================================================
-- 3. DROP funções de import + finalize (RPA OPC 455 path)
-- =============================================================================

DROP FUNCTION IF EXISTS public.upsert_chaves_cte_bulk(jsonb);
DROP FUNCTION IF EXISTS public.finalize_import_chaves_cte(text);

-- =============================================================================
-- 4. DROP tabelas pesadas
--    nf_chave_cte: 370MB + 4 índices ~220MB. ocorrencias_dexpara: ~16KB.
--    CASCADE remove FKs e índices automaticamente.
-- =============================================================================

DROP TABLE IF EXISTS public.nf_chave_cte CASCADE;
DROP TABLE IF EXISTS public.ocorrencias_dexpara CASCADE;

DO $$
BEGIN
  RAISE NOTICE 'mig 195 destrutiva concluída. ~600MB liberados, RPCs viraram stubs.';
END $$;
