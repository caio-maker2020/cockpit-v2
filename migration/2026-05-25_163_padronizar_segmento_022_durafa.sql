-- =============================================================================
-- 2026-05-25_163 — Padronização segmento 022 (MOTOBIKE) → DURAFA
--
-- Caio 2026-05-25: cards do segmento 022 estavam aparecendo no Cockpit do
-- DUILIO porque (a) Bastão informava responsavel_relacionamento=DUILIO no
-- payload das pendências MOTOBIKE, (b) DURAFA estava com cockpit_ativo=false
-- e o Path 1 (carteira) do resolver exige cockpit_ativo=true.
--
-- Ações desta migration (já executadas inline):
--   1. INSERT 8 CNPJs órfãos 022 em public.clientes (MB IMPORTACAO, MOTO FEST,
--      C R FILHO, R2, GOW HELMETS, MARCELO, CICLOVIX, VIVIANE)
--   2. INSERT 8 tracking_credentials stubs apontando pra DURAFA
--   3. UPDATE operadores SET carteira=36 CNPJs WHERE nome='DURAFA'
--   4. UPDATE operadores SET cockpit_ativo=true WHERE nome='DURAFA'
--   5. UPDATE cards SET responsavel/assigned/segmento → DURAFA pra TODOS cards
--      ativos com agent_state.segmento_cliente LIKE '022%' (50 cards afetados)
--   6. INSERT card_events 'OperadorReatribuido' com payload de auditoria
--
-- Regra geral padronizada:
--   "Todo card cujo agent_state->>'segmento_cliente' começa com '022' DEVE
--    estar atribuído a DURAFA (operador único do segmento MOTOBIKE)."
--
-- Esta migration cria a função `padronizar_atribuicao_segmento_022()`
-- reusável — chamável manualmente quando algum sync futuro deixar resíduo.
-- skill: supabase-postgres-best-practices
--   - SECURITY DEFINER + SET search_path=public (anti-injection)
--   - GRANT EXECUTE só pra service_role
--   - Idempotente: WHERE clause exclui cards já corretos
-- =============================================================================

CREATE OR REPLACE FUNCTION public.padronizar_atribuicao_segmento_022()
RETURNS TABLE(card_id uuid, responsavel_anterior text, assigned_anterior uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_durafa_id uuid;
BEGIN
  SELECT id INTO v_durafa_id FROM public.operadores WHERE nome='DURAFA' LIMIT 1;
  IF v_durafa_id IS NULL THEN
    RAISE EXCEPTION 'Operador DURAFA não encontrado — não posso padronizar';
  END IF;

  RETURN QUERY
  WITH afetados AS (
    SELECT id, responsavel_relacionamento AS resp_old, assigned_operator_id AS aid_old
    FROM public.cards
    WHERE state NOT IN ('RESOLVIDO','CANCELADO')
      AND agent_state->>'segmento_cliente' LIKE '022%'
      AND (responsavel_relacionamento IS DISTINCT FROM 'DURAFA'
           OR assigned_operator_id IS DISTINCT FROM v_durafa_id)
  ),
  upd AS (
    UPDATE public.cards c
    SET responsavel_relacionamento='DURAFA',
        assigned_operator_id=v_durafa_id,
        segmento_codigo='022'
    FROM afetados a
    WHERE c.id=a.id
    RETURNING c.id, a.resp_old, a.aid_old
  ),
  audit AS (
    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    SELECT u.id, 'OperadorReatribuido', 'system', 'padronizar_atribuicao_segmento_022',
           jsonb_build_object(
             'responsavel_anterior', u.resp_old,
             'assigned_anterior', u.aid_old,
             'responsavel_novo', 'DURAFA',
             'motivo', 'Padronização segmento 022 → DURAFA',
             'segmento', '022'
           )
    FROM upd u
    RETURNING card_events.card_id
  )
  SELECT u.id, u.resp_old, u.aid_old FROM upd u;
END;
$$;

REVOKE ALL ON FUNCTION public.padronizar_atribuicao_segmento_022() FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.padronizar_atribuicao_segmento_022() TO service_role;

COMMENT ON FUNCTION public.padronizar_atribuicao_segmento_022() IS
  'Caio 2026-05-25: garante que TODO card seg=022 ativo está atribuído a DURAFA. '
  'Idempotente — executar quando suspeitar de resíduo de Bastão (responsavel cru).';
