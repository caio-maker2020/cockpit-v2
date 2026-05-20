-- =============================================================================
-- prioridades_kanban_status: adicionar 'escalado_gerencia_interna' (5º estado)
--
-- Caio 2026-05-20: funil de cobrança PRIORIDADES AI tem 3 níveis, não 2:
--   1. Coordenador de Entrega (papel=coordenador_entrega)  → "COBRADO"
--   2. Gerente da Base        (papel=gerente_base)         → "ESCALADO"
--   3. Gerente de Relacionamento (papel=gerente_relacionamento, Thaini) →
--      "ESCALADO GERÊNCIA INTERNA" (NOVO)
--
-- Antes, gerente_relacionamento caía em 'escalado' junto com coord (status
-- achatado). Front front Lovable já tem coluna nova "ESCALADO GERÊNCIA INTERNA"
-- mas backend recusava o valor por CHECK constraint. Migration relaxa.
--
-- Idempotente: roda 2x sem efeito colateral.
-- =============================================================================

ALTER TABLE public.cards
  DROP CONSTRAINT IF EXISTS cards_prioridades_kanban_status_check;

ALTER TABLE public.cards
  ADD CONSTRAINT cards_prioridades_kanban_status_check
  CHECK (
    prioridades_kanban_status IS NULL
    OR prioridades_kanban_status = ANY (
      ARRAY[
        'parada'::text,
        'cobrado'::text,
        'escalado'::text,
        'escalado_gerencia_interna'::text,
        'resolvido'::text
      ]
    )
  );

COMMENT ON COLUMN public.cards.prioridades_kanban_status IS
  'Coluna do kanban PRIORIDADES AI. Funil: parada → cobrado (coordenador) → '
  'escalado (gerente da base) → escalado_gerencia_interna (gerente_relacionamento/Thaini) → resolvido.';
