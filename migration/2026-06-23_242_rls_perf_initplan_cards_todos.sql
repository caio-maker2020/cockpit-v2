-- =============================================================================
-- PERF RLS — cards + todos: avaliar contexto do operador 1x/query (InitPlan),
-- não 1x/linha. Causa-raiz do apagão de 2026-06-23 (14:30-15:15 BRT).
--
-- PROBLEMA (Caio 2026-06-23): as policies chamavam
-- `card_visivel_pelo_operador_atual(...)` (e, em todos, via EXISTS correlacionado
-- em cards). Essa função é SECURITY DEFINER chamada POR LINHA, e por dentro chama
-- outras 4 funções SECDEF (current_operador_papel/id/carteira/segmentos). Como
-- está aninhada numa função per-row, o Postgres reavalia tudo por linha → a query
-- de `todos` do front consumia 58% de TODA a CPU (307ms/chamada; board chegando a
-- 40s sob carga). Isso saturou conexões/workers do tier pequeno → front "não
-- carregava". Ver memória project_incidente_apagao_rls_per_row_tier_ceiling_2026_06_23.
--
-- FIX (padrão oficial Supabase — skill supabase-postgres-best-practices,
-- security-rls-performance): INLINE o predicado na policy e envolva cada chamada
-- de contexto do operador em `(SELECT ...)`. Subquery NÃO-correlacionada vira
-- InitPlan/hashed-SubPlan → avaliada UMA vez por query e cacheada; o trabalho por
-- linha vira só comparação barata. Para arrays use `col = ANY(SELECT unnest(fn()))`
-- (NÃO `col = ANY((SELECT fn()))` — dá erro `text = text[]`).
--
-- ⚠️ NÃO "refatore" esse predicado de volta pra dentro de uma função (mesmo STABLE):
-- dentro de função per-row o `(SELECT ...)` NÃO é hoisteado e o ganho some.
-- Tem que ficar inline na policy.
--
-- EQUIVALÊNCIA PROVADA antes de aplicar: para os 6 operadores ativos, o conjunto
-- de cards visíveis pelo predicado NOVO == predicado ANTIGO (0 divergências).
-- Medido: cards count(*) 150ms → 3,3ms (~45x); custo 4854 → 845.
-- Guard de não-regressão: _shared/rls-cards-perf.test.ts.
-- =============================================================================

-- ---------- cards: SELECT ----------
DROP POLICY IF EXISTS cards_select_role ON public.cards;
CREATE POLICY cards_select_role ON public.cards
  FOR SELECT TO authenticated
  USING (
    (SELECT public.current_operador_papel()) = 'gestor'
    OR assigned_operator_id = (SELECT public.current_operador_id())
  );

DROP POLICY IF EXISTS cards_select_visibilidade ON public.cards;
CREATE POLICY cards_select_visibilidade ON public.cards
  FOR SELECT TO authenticated
  USING (
    (SELECT public.current_operador_papel()) = 'gestor'
    OR assigned_operator_id = (SELECT public.current_operador_id())
    OR (pagador = ANY (SELECT unnest(public.current_operador_carteira())))
    OR (segmento_codigo = ANY (SELECT unnest(public.current_operador_segmentos())))
  );

-- ---------- cards: UPDATE ----------
DROP POLICY IF EXISTS cards_update_role ON public.cards;
CREATE POLICY cards_update_role ON public.cards
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.current_operador_papel()) = 'gestor'
    OR assigned_operator_id = (SELECT public.current_operador_id())
  );

DROP POLICY IF EXISTS cards_update_visibilidade ON public.cards;
CREATE POLICY cards_update_visibilidade ON public.cards
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.current_operador_papel()) = 'gestor'
    OR assigned_operator_id = (SELECT public.current_operador_id())
    OR (pagador = ANY (SELECT unnest(public.current_operador_carteira())))
    OR (segmento_codigo = ANY (SELECT unnest(public.current_operador_segmentos())))
  )
  WITH CHECK (
    (SELECT public.current_operador_papel()) = 'gestor'
    OR assigned_operator_id = (SELECT public.current_operador_id())
    OR (pagador = ANY (SELECT unnest(public.current_operador_carteira())))
    OR (segmento_codigo = ANY (SELECT unnest(public.current_operador_segmentos())))
  );

-- ---------- todos: SELECT (visível se o card é visível) ----------
DROP POLICY IF EXISTS todos_select_via_card ON public.todos;
CREATE POLICY todos_select_via_card ON public.todos
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = todos.card_id
        AND (
          (SELECT public.current_operador_papel()) = 'gestor'
          OR c.assigned_operator_id = (SELECT public.current_operador_id())
          OR (c.pagador = ANY (SELECT unnest(public.current_operador_carteira())))
          OR (c.segmento_codigo = ANY (SELECT unnest(public.current_operador_segmentos())))
        )
    )
  );

-- ---------- todos: UPDATE (semântica original: só gestor OU card atribuído a mim;
--             NÃO inclui carteira/segmento — mantida idêntica, só cacheada) ----------
DROP POLICY IF EXISTS todos_update_via_card ON public.todos;
CREATE POLICY todos_update_via_card ON public.todos
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.current_operador_papel()) = 'gestor'
    OR todos.card_id IN (
      SELECT cards.id FROM public.cards
      WHERE cards.assigned_operator_id = (SELECT public.current_operador_id())
    )
  );
