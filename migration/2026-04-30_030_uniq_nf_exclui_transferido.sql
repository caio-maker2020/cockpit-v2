-- ============================================================================
-- Cockpit v2 — UNIQUE NF exclui TRANSFERIDO (alinha com filtro do sync)
-- Data: 2026-04-30
--
-- Bug: O índice uniq_cards_nf_active filtra apenas RESOLVIDO/CANCELADO,
-- mas o sync-bastao Pass A exclui TRANSFERIDO no SELECT (cards em
-- TRANSFERIDO são "fora de escopo" e não devem ser reabertos pelo sync).
-- Quando o backfill move um card pra TRANSFERIDO e o Bastão ainda retorna
-- a pendência (porque o setor recebedor ainda não fechou no SSW), o Pass A
-- não acha o card no SELECT, tenta INSERT, e bate no constraint.
--
-- Fix: alinhar constraint com SELECT — TRANSFERIDO sai do índice unique
-- (mesma lógica de RESOLVIDO/CANCELADO: cards "passados" não são unique).
-- TRATATIVA_PENDENTE permanece no constraint (é estado ativo, não pode
-- duplicar pra mesma NF).
-- ============================================================================

DROP INDEX IF EXISTS public.uniq_cards_nf_active;

CREATE UNIQUE INDEX uniq_cards_nf_active
  ON public.cards (nf)
  WHERE nf IS NOT NULL
    AND state NOT IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO');

COMMENT ON INDEX public.uniq_cards_nf_active IS
  'NF única por card ativo. Cards em RESOLVIDO/CANCELADO/TRANSFERIDO são '
  'históricos e não contam — permite criar novo card pra mesma NF se cliente '
  'cobrar de volta após transferência. Alinhado com filtro do sync-bastao Pass A.';

-- Mesma alinhamento pra bastao_pendencia_id (excluir TRANSFERIDO)
DROP INDEX IF EXISTS public.uniq_cards_bastao_pendencia_active;

CREATE UNIQUE INDEX uniq_cards_bastao_pendencia_active
  ON public.cards (bastao_pendencia_id)
  WHERE bastao_pendencia_id IS NOT NULL
    AND state NOT IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO');
