-- ============================================================================
-- Cockpit v2 — RLS por papel + filtro por segmento + carteira de clientes
-- Data: 2026-04-30
--
-- Modelo de visibilidade:
--   - Gestor (papel='gestor'): vê TUDO
--   - Operador: vê cards onde QUALQUER critério bate (OR):
--       (a) assigned_operator_id = id do operador (atribuição direta)
--       (b) pagador ∈ operadores.carteira (CNPJs específicos do operador)
--       (c) segmento_codigo ∈ operadores.segmentos (códigos de segmento SSW)
--
-- Pra Larissa: as 3 abas da planilha (007/010/018) viram entradas em
-- operadores.segmentos. Os 193 CNPJs viram entradas em operadores.carteira.
-- Redundante mas defensivo — se um card chegar com pagador certo MAS segmento
-- errado (ou vice-versa), ela vê.
--
-- Pra escalar 11 operadores: cada um recebe sua lista de carteira + segmentos.
-- Sem tabelas N:N novas — arrays nos próprios operadores.
-- ============================================================================

-- ============================================================================
-- 1. Coluna nova: cards.segmento_codigo (código numérico do SSW: 007/010/018/...)
-- ============================================================================
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS segmento_codigo text;

CREATE INDEX IF NOT EXISTS idx_cards_segmento_codigo
  ON public.cards(segmento_codigo)
  WHERE segmento_codigo IS NOT NULL;

COMMENT ON COLUMN public.cards.segmento_codigo IS
  'Código numérico do segmento do cliente no SSW (ex: 007, 010, 018). '
  'Populado por sync-bastao (a partir de pendencia.segmento_cliente) ou '
  'lookup em clientes pelo cnpj_pagador. Usado em RLS pra filtro por operador.';

-- ============================================================================
-- 2. Coluna nova: operadores.segmentos (códigos que o operador atende)
-- ============================================================================
ALTER TABLE public.operadores
  ADD COLUMN IF NOT EXISTS segmentos text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.operadores.segmentos IS
  'Códigos de segmento SSW que o operador atende (ex: {007,010,018} pra Larissa). '
  'Filtro complementar à carteira (CNPJs específicos). RLS faz OR entre os dois.';

COMMENT ON COLUMN public.operadores.carteira IS
  'CNPJs/CPFs de clientes que o operador atende. Junto com segmentos[], compõe '
  'o filtro de visibilidade RLS. Mantido como text[] pra permitir SQL com ANY().';

-- ============================================================================
-- 3. Tabela clientes (catálogo de CNPJ → nome + segmento)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.clientes (
  cnpj_cpf text PRIMARY KEY CHECK (cnpj_cpf ~ '^\d+$' AND length(cnpj_cpf) IN (11, 14)),
  nome text NOT NULL,
  segmento_codigo text,
  segmento_nome text,
  ativo boolean NOT NULL DEFAULT true,
  observacao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clientes_segmento ON public.clientes(segmento_codigo);
CREATE INDEX IF NOT EXISTS idx_clientes_ativo ON public.clientes(ativo) WHERE ativo = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'clientes_set_updated_at'
  ) THEN
    CREATE TRIGGER clientes_set_updated_at
      BEFORE UPDATE ON public.clientes
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;

CREATE POLICY clientes_select_authenticated ON public.clientes
  FOR SELECT TO authenticated USING (true);

CREATE POLICY clientes_modify_gestor ON public.clientes
  FOR ALL TO authenticated
  USING (public.current_operador_papel() = 'gestor')
  WITH CHECK (public.current_operador_papel() = 'gestor');

COMMENT ON TABLE public.clientes IS
  'Catálogo de clientes (CNPJ/CPF → segmento). Importado a partir das '
  'planilhas de carteira por operador (Caio mantém). UI pode exibir nome '
  'do cliente nos cards via JOIN cards.pagador = clientes.cnpj_cpf.';

-- ============================================================================
-- 4. RPC helpers: current_operador_id() + current_operador_carteira() +
--    current_operador_segmentos() — usados em RLS sem repetir SELECT
-- ============================================================================
CREATE OR REPLACE FUNCTION public.current_operador_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.operadores WHERE user_id = auth.uid() AND ativo = true LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_operador_carteira()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT carteira FROM public.operadores WHERE user_id = auth.uid() AND ativo = true LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_operador_segmentos()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT segmentos FROM public.operadores WHERE user_id = auth.uid() AND ativo = true LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.current_operador_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_operador_carteira() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_operador_segmentos() TO authenticated;

-- ============================================================================
-- 5. Função predicate de visibilidade — usada em todas as RLS policies de cards
--    e tabelas relacionadas. Centraliza a regra OR.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.card_visivel_pelo_operador_atual(
  p_assigned_operator_id uuid,
  p_pagador text,
  p_segmento_codigo text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.current_operador_papel() = 'gestor'
    OR p_assigned_operator_id = public.current_operador_id()
    OR (p_pagador IS NOT NULL AND p_pagador = ANY(public.current_operador_carteira()))
    OR (p_segmento_codigo IS NOT NULL AND p_segmento_codigo = ANY(public.current_operador_segmentos()));
$$;

GRANT EXECUTE ON FUNCTION public.card_visivel_pelo_operador_atual(uuid, text, text) TO authenticated;

-- ============================================================================
-- 6. RLS policies — cards
-- ============================================================================
DROP POLICY IF EXISTS cards_select_authenticated ON public.cards;
DROP POLICY IF EXISTS cards_select ON public.cards;
DROP POLICY IF EXISTS cards_update_authenticated ON public.cards;
DROP POLICY IF EXISTS cards_update ON public.cards;

CREATE POLICY cards_select_visibilidade ON public.cards
  FOR SELECT TO authenticated
  USING (public.card_visivel_pelo_operador_atual(assigned_operator_id, pagador, segmento_codigo));

CREATE POLICY cards_update_visibilidade ON public.cards
  FOR UPDATE TO authenticated
  USING (public.card_visivel_pelo_operador_atual(assigned_operator_id, pagador, segmento_codigo))
  WITH CHECK (public.card_visivel_pelo_operador_atual(assigned_operator_id, pagador, segmento_codigo));

-- ============================================================================
-- 7. RLS policies — todos (deriva visibilidade do card pai)
-- ============================================================================
DROP POLICY IF EXISTS todos_select_authenticated ON public.todos;
DROP POLICY IF EXISTS todos_select ON public.todos;

CREATE POLICY todos_select_via_card ON public.todos
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = todos.card_id
        AND public.card_visivel_pelo_operador_atual(c.assigned_operator_id, c.pagador, c.segmento_codigo)
    )
  );

-- ============================================================================
-- 8. RLS policies — messages_inbox + card_events (deriva do card pai)
-- ============================================================================
DROP POLICY IF EXISTS messages_inbox_select_authenticated ON public.messages_inbox;
DROP POLICY IF EXISTS messages_inbox_select ON public.messages_inbox;

CREATE POLICY messages_inbox_select_via_card ON public.messages_inbox
  FOR SELECT TO authenticated
  USING (
    card_id IS NULL  -- mensagens sem card ainda não vinculadas — gestor vê tudo, operador nada
      AND public.current_operador_papel() = 'gestor'
    OR EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = messages_inbox.card_id
        AND public.card_visivel_pelo_operador_atual(c.assigned_operator_id, c.pagador, c.segmento_codigo)
    )
  );

DROP POLICY IF EXISTS card_events_select_authenticated ON public.card_events;
DROP POLICY IF EXISTS card_events_select ON public.card_events;

CREATE POLICY card_events_select_via_card ON public.card_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = card_events.card_id
        AND public.card_visivel_pelo_operador_atual(c.assigned_operator_id, c.pagador, c.segmento_codigo)
    )
  );

-- ============================================================================
-- 9. Backfill — cards.segmento_codigo a partir do agent_state do Bastão
-- ============================================================================
UPDATE public.cards
SET segmento_codigo = agent_state->>'segmento_cliente'
WHERE segmento_codigo IS NULL
  AND agent_state ? 'segmento_cliente'
  AND length(coalesce(agent_state->>'segmento_cliente', '')) > 0;

-- ============================================================================
-- Notas operacionais
-- ============================================================================
-- - service_role bypassa RLS (Edge Functions continuam funcionando normalmente).
-- - Quando criar novo operador, popular segmentos[] e/ou carteira[] direto.
-- - Caso de operador sem nenhum dos dois preenchidos: vê só cards onde
--   assigned_operator_id = ele (atribuição direta).
-- - Pra desabilitar acesso temporário: SET ativo=false → operador não acha
--   match em current_operador_id() e fica sem visibilidade.
