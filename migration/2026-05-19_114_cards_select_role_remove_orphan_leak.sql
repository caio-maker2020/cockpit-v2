-- ============================================================================
-- Cockpit v2 — Fix RLS cards_select_role: remove cláusula assigned IS NULL
-- Data: 2026-05-19
--
-- Bug âncora NF 568107 (Caio 2026-05-19): card desatribuído (assigned_
-- operator_id=NULL + responsavel_relacionamento=NULL) por causa de carteira
-- dormente da Ingrid ficou visível pra Larissa. Causa: policy
-- `cards_select_role` tinha cláusula `assigned_operator_id IS NULL` que
-- tornava cards órfãos visíveis pra TODOS os operadores.
--
-- Antes:
--   gestor OR assigned_operator_id IS NULL OR assigned_operator_id = me
--
-- Depois:
--   gestor OR assigned_operator_id = me
--
-- Policy irmã `cards_select_visibilidade` permanece intacta — dá visibilidade
-- a operadores via carteira/segmento (`card_visivel_pelo_operador_atual`).
-- Combinadas (OR entre policies): operador comum vê o que está assigned
-- a ele OU o que cai na carteira/segmento dele. Gestor vê tudo.
--
-- Cards órfãos legítimos (sem dono, sem carteira/segmento) viram visíveis
-- APENAS pra gestor — comportamento desejado pra cards de exceção (ex:
-- carteira_dormente da Ingrid até cockpit_ativo=true).
-- ============================================================================

DROP POLICY IF EXISTS cards_select_role ON public.cards;

CREATE POLICY cards_select_role
ON public.cards
FOR SELECT
TO authenticated
USING (
  public.current_operador_papel() = 'gestor'
  OR assigned_operator_id = public.current_operador_id()
);

COMMENT ON POLICY cards_select_role ON public.cards IS
  'Caio 2026-05-19: removida cláusula `assigned_operator_id IS NULL`. Cards '
  'órfãos só são visíveis pra gestor — evita vazamento entre operadores '
  '(bug NF 568107 NORTEL apareceu pra Larissa após desatribuição). '
  'Visibilidade por carteira/segmento continua via cards_select_visibilidade.';
