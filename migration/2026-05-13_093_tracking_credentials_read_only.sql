-- =============================================================================
-- 2026-05-13_093 — tracking_credentials read-only
--
-- Caio 2026-05-13 (Fase 3 plano "hoje-usamos-o-bastao", ADR 0005):
--
-- A tabela `tracking_credentials` armazenava senhas do "Site de rastreamento"
-- por CNPJ pagador, usadas pelo tracking SSW público (/api/trackingpag). Esse
-- caminho foi descontinuado em favor do scraping interno SSW (opção 101) que
-- usa login Sal compartilhado e cobre TODAS as ocs (público ocultava 31).
--
-- Esta migration:
--   1. Revoga INSERT/UPDATE/DELETE de service_role e authenticated.
--   2. Mantém SELECT (read-only) pra preservar histórico — útil pra reconstruir
--      caso seja necessário no futuro.
--   3. Adiciona COMMENT marcando deprecation explícita.
--
-- Callers JÁ MIGRADOS pro SSW interno:
--   - atualizar-card-via-tracking (2026-05-12)
--   - voltar-para-to-do-com-rastreio v3 (2026-05-13)
--   - sync-bastao Pass B + Pass E (2026-05-13)
--   - vinculador 3ª fonte removida (2026-05-13)
--   - r-evidencia unificado (2026-05-13)
--   - verificar-evidencia.ts.temEvidenciaParaOc reescrito (2026-05-13)
--
-- Caller ainda lendo (READ-only OK):
--   - cadastrar-tracking-auto (deprecated, sem novo uso esperado)
--
-- Quando remover totalmente:
--   - 2 sprints sem reads = pode DROP TABLE. Migration futura.
-- =============================================================================

-- Defesa em profundidade: revoga DML em massa. Mesmo se algum caller esquecido
-- tentar INSERT/UPDATE/DELETE, falha com permission denied (não silencia).
REVOKE INSERT, UPDATE, DELETE ON public.tracking_credentials FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.tracking_credentials FROM service_role;
REVOKE INSERT, UPDATE, DELETE ON public.tracking_credentials FROM anon;

-- SELECT permanece (leitura histórica)
GRANT SELECT ON public.tracking_credentials TO authenticated;
GRANT SELECT ON public.tracking_credentials TO service_role;

-- Comentário SQL pra qualquer dev futuro entender o status
COMMENT ON TABLE public.tracking_credentials IS
  'DEPRECATED Caio 2026-05-13 (ADR 0005). Tabela armazenava senhas do tracking SSW público, descontinuado em favor do SSW interno (opção 101). READ-ONLY a partir desta migration (INSERT/UPDATE/DELETE revogados). Mantida pra histórico. Sem novos callers permitidos. Plano de remoção total: 2 sprints sem reads → DROP TABLE.';

-- Política RLS adicional (se RLS estiver ativa) bloqueando escritas
-- mesmo via service_role com config bypass desativado. Segurança extra.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'tracking_credentials'
      AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      AND relrowsecurity = true
  ) THEN
    -- RLS já está ativa — adiciona política RESTRICTIVE bloqueando writes
    DROP POLICY IF EXISTS tracking_credentials_read_only ON public.tracking_credentials;
    CREATE POLICY tracking_credentials_read_only ON public.tracking_credentials
      AS RESTRICTIVE
      FOR ALL
      TO authenticated, service_role
      USING (current_setting('request.method', true) IN ('GET', 'HEAD') OR current_setting('request.method', true) IS NULL);
    -- Nota: current_setting('request.method') só funciona em contexto PostgREST.
    -- Pra service_role direto (Edge Functions), o REVOKE acima é a defesa primária.
  END IF;
END $$;

-- Audit: registra event pra histórico do sistema
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT
  NULL::uuid,
  'TabelaDeprecada',
  'system',
  'migration-2026-05-13_093',
  jsonb_build_object(
    'tabela', 'tracking_credentials',
    'motivo', 'Fase 3 plano hoje-usamos-o-bastao — SSW interno (opção 101) substituiu tracking público',
    'adr', '0005',
    'reversivel', true,
    'comando_reverter', 'GRANT INSERT, UPDATE, DELETE ON public.tracking_credentials TO authenticated, service_role'
  )
WHERE EXISTS (
  -- Só insere o evento se card_events aceitar card_id NULL.
  -- Defesa: se schema exigir not-null, este block falha silencioso.
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'card_events'
    AND column_name = 'card_id'
    AND is_nullable = 'YES'
);
