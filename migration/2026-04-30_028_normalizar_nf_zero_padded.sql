-- ============================================================================
-- Cockpit v2 — Normalização NF (zeros à esquerda)
-- Data: 2026-04-30
--
-- Bug: Bastão API às vezes retorna NF com prefixo de zeros ("000757683"),
-- às vezes sem ("757683"). O sync-bastao casava direto por string, criando
-- DOIS cards distintos pra mesma NF.
--
-- Estado atual no banco:
--   - 26 cards 0-padded com PAR sem zeros (duplicatas reais) — cancelar
--   - 5 cards 0-padded SEM par (Bastão retorna sempre com zeros pra elas)
--     — renormalizar (UPDATE nf removendo zeros)
--
-- Após essa migration + sync-bastao atualizado, o banco tem invariante:
-- nenhuma NF começa com '0'.
-- ============================================================================

-- =============================================================================
-- 1. Cancelar duplicatas 0-padded onde já existe par sem zeros
-- =============================================================================

WITH dups AS (
  SELECT c1.id, c1.nf, c1.state
  FROM public.cards c1
  WHERE c1.nf LIKE '0%'
    AND c1.state NOT IN ('CANCELADO')
    AND EXISTS (
      SELECT 1 FROM public.cards c2
      WHERE c2.id <> c1.id
        AND regexp_replace(c2.nf, '^0+', '') = regexp_replace(c1.nf, '^0+', '')
    )
),
canceled AS (
  UPDATE public.cards c
  SET state = 'CANCELADO',
      lock_aguardando_validacao = false
  FROM dups d
  WHERE c.id = d.id
  RETURNING c.id, c.nf, d.state AS state_anterior
)
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT
  id,
  'CardCanceladoDuplicataZeroPadding',
  'system',
  'migration_028',
  jsonb_build_object(
    'nf_original', nf,
    'nf_normalizada', regexp_replace(nf, '^0+', ''),
    'state_anterior', state_anterior,
    'motivo', 'Cancelado: existia card duplicado com NF sem zeros à esquerda'
  )
FROM canceled;

-- =============================================================================
-- 2. Renormalizar cards 0-padded sem par
-- =============================================================================

WITH orfaos AS (
  SELECT c1.id, c1.nf, regexp_replace(c1.nf, '^0+', '') AS nf_norm
  FROM public.cards c1
  WHERE c1.nf LIKE '0%'
    AND c1.state NOT IN ('CANCELADO')
    AND NOT EXISTS (
      SELECT 1 FROM public.cards c2
      WHERE c2.id <> c1.id
        AND regexp_replace(c2.nf, '^0+', '') = regexp_replace(c1.nf, '^0+', '')
    )
),
renomeados AS (
  UPDATE public.cards c
  SET nf = o.nf_norm
  FROM orfaos o
  WHERE c.id = o.id
  RETURNING c.id, o.nf AS nf_anterior, c.nf AS nf_atual
)
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT
  id,
  'NfRenormalizadaSemZeros',
  'system',
  'migration_028',
  jsonb_build_object(
    'nf_anterior', nf_anterior,
    'nf_atual', nf_atual,
    'motivo', 'Removido prefixo de zeros (alinha com formato canônico do Cockpit)'
  )
FROM renomeados;

-- =============================================================================
-- 3. Validação pós-migration: invariante "nenhuma NF começa com 0"
-- =============================================================================

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.cards
  WHERE nf LIKE '0%' AND state NOT IN ('CANCELADO');

  IF v_count > 0 THEN
    RAISE EXCEPTION 'Pós-migration: % cards ativos ainda com NF iniciando com 0', v_count;
  END IF;
END $$;
