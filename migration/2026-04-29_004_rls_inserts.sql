-- ============================================================================
-- Cockpit v2 — RLS missing INSERT policies (patch da 001)
-- Data: 2026-04-29
-- Motivo: a UI Lovable precisa INSERT em card_events quando o operador aprova/
-- rejeita ação ou envia mensagem manual. A 001 só criou SELECT em card_events;
-- INSERT autenticado caía em "policy violation". Service_role continua
-- bypassando — agentes/sistema (server-side) não dependem desta policy.
-- ============================================================================

-- card_events — operador autenticado pode INSERT eventos de eventos próprios
-- (actor_type='operator' + actor_id = operadores.id atual) em cards que ele vê.
CREATE POLICY card_events_insert_operator ON public.card_events
  FOR INSERT TO authenticated
  WITH CHECK (
    actor_type = 'operator'
    AND actor_id = public.current_operador_id()::text
    AND (
      public.current_operador_papel() = 'gestor'
      OR card_id IN (
        SELECT id FROM public.cards
        WHERE assigned_operator_id = public.current_operador_id()
      )
    )
  );

-- pendencias — INSERT/DELETE pra gestor; operador edita as suas via UPDATE
-- (já existe). Útil quando alguém marca follow-up manual.
CREATE POLICY pendencias_insert_via_card ON public.pendencias
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_operador_papel() = 'gestor'
    OR card_id IN (
      SELECT id FROM public.cards
      WHERE assigned_operator_id = public.current_operador_id()
    )
  );
