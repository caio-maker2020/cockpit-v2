-- =============================================================================
-- 2026-05-27_175 — ocorrencias_dexpara oc=33 wire 86→62
--
-- Caio 2026-05-27 (NF 713556 falhou 3x DURAFA): SSW alterou wire code da
-- oc=33 (REVERSAO DE PERDAS) de 86 para 62. Executor traduz codigo_ssw →
-- codigo_api via lookup_codigo_api(33), que lê desta tabela ordenando por
-- created_at DESC ativo=true LIMIT 1.
--
-- CORREÇÃO DE PERCEPÇÃO IMPORTANTE: o OC_REMAP_API_SSW em ssw-client.ts
-- (criado em 2026-05-26 com map "33":"62") está MORTO — executor não passa
-- input.codigo=33 pra ssw-client; passa input.codigo=String(codigoApi),
-- onde codigoApi vem desta tabela. O wire correto é controlado AQUI.
--
-- Histórico do mapeamento:
--   - 2026-04-29: dexpara criada com 86 → 33 (codigo_api 86 vira oc=33 no painel)
--   - 2026-05-26 manhã: tentativa "71" (não aplicado nesta tabela — só ssw-client)
--   - 2026-05-26 tarde: tentativa "62" (não aplicado nesta tabela)
--   - 2026-05-27: ESTA MIG aplica 62 corretamente na dexpara — executor agora envia 62
--
-- Idempotente. Inativa a row antiga (86) pra audit.
--
-- skill: supabase-postgres-best-practices
--   - INSERT ON CONFLICT (codigo_api) DO UPDATE pra idempotência
--   - PK é codigo_api, INSERT 62 cria nova row
--   - UPDATE inativa codigo_api=86 preserva histórico (não DELETE)
-- =============================================================================

-- 1. Insere/atualiza row 62 → 33 (ativo)
INSERT INTO public.ocorrencias_dexpara (codigo_api, codigo_ssw, descricao, ativo, observacao)
VALUES (
  62,
  33,
  'REVERSAO DE PERDAS INICIADA',
  true,
  'Caio 2026-05-27: SSW alterou wire code de 86 para 62 — testado via NF 713556 DURAFA (falhou 3x com 86 "CODIGO SSW NAO CADASTRADO"). Substitui a row 86 (inativada na mesma migration).'
)
ON CONFLICT (codigo_api) DO UPDATE SET
  codigo_ssw = EXCLUDED.codigo_ssw,
  descricao = EXCLUDED.descricao,
  ativo = true,
  observacao = EXCLUDED.observacao,
  updated_at = now();

-- 2. Inativa a row antiga (86)
UPDATE public.ocorrencias_dexpara
SET ativo = false,
    observacao = 'INATIVADO 2026-05-27: SSW mudou wire code da oc=33 pra 62 — ver row codigo_api=62.',
    updated_at = now()
WHERE codigo_api = 86;

-- 3. Validação
DO $$
DECLARE
  v_codigo_api integer;
BEGIN
  SELECT lookup_codigo_api(33) INTO v_codigo_api;
  IF v_codigo_api != 62 THEN
    RAISE EXCEPTION 'lookup_codigo_api(33) retornou %, esperado 62', v_codigo_api;
  END IF;
  RAISE NOTICE 'lookup_codigo_api(33) = 62 ✓';
END $$;
