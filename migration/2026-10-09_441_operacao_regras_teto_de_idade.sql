-- =============================================================================
-- 2026-10-09_441 — Operação: teto de idade na regra aprendida (`estado_dias_parado_max`)
--                  (ADR 0041 D10, rodada 8 do minerador; INV-188).
-- =============================================================================
-- POR QUÊ: em 09/10, 96,7 % das 7.858 notas abertas receberam "aguardar". 544 delas estavam
-- paradas havia 8+ dias (290 na oc 12, 84 na 7, 73 na 29) e herdavam o "aguardar" aprendido de
-- notas que andam sozinhas no mesmo dia. `dias_parado_min` só tinha PISO; faltava o TETO.
--
-- estado_dias_parado_max: inteiro 1..365 (≥ estado_dias_parado_min quando ambos). A regra só
-- casa se a idade da nota (dias inteiros desde data_ultima_ocorrencia) for ≤ teto. Item sem data
-- NÃO casa uma regra com teto. Soma 0 de especificidade: só restringe (a filha d:N segue vencendo).
-- O código (_shared/operacao-sugestao.ts) lê a tabela com select("*"): publicado ANTES desta mig,
-- só não vê teto (regras.json da rodada 8 sem a coluna = comportamento da rodada 7).
--
-- ─── NOTAS DE RISCO ──────────────────────────────────────────────────────────
-- (a) Só ADD COLUMN nullable + CHECK em op_regras_sugestao (mig 434). Nenhum dado existente muda.
-- (b) DEPENDÊNCIAS: 434–440.
-- (c) CLASSIFICAÇÃO: TIPO B.
-- (d) REVERSÃO: ALTER TABLE public.op_regras_sugestao DROP CONSTRAINT IF EXISTS oprs_dias_max,
--       DROP COLUMN IF EXISTS estado_dias_parado_max;
--
-- ⚠ NÃO APLICADA (nem dry-run). ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'op_regras_sugestao' AND column_name = 'estado_instrucao_modelo') THEN
    RAISE EXCEPTION 'mig 441 exige a 440 aplicada antes';
  END IF;
END $$;

ALTER TABLE public.op_regras_sugestao ADD COLUMN IF NOT EXISTS estado_dias_parado_max integer;

ALTER TABLE public.op_regras_sugestao DROP CONSTRAINT IF EXISTS oprs_dias_max;
ALTER TABLE public.op_regras_sugestao ADD CONSTRAINT oprs_dias_max CHECK (
  estado_dias_parado_max IS NULL OR (
    estado_dias_parado_max BETWEEN 1 AND 365
    AND (estado_dias_parado_min IS NULL OR estado_dias_parado_max >= estado_dias_parado_min)));

COMMENT ON COLUMN public.op_regras_sugestao.estado_dias_parado_max IS
  'Teto de idade (dias desde a última oc): acima disso a regra não casa. Rodada 8 (mig 441).';
