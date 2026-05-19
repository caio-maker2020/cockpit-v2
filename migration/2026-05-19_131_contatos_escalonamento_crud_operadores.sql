-- ============================================================================
-- Cockpit v2 — RLS contatos_escalonamento: libera CRUD pra operadores
-- Data: 2026-05-19
--
-- Decisão Caio 2026-05-19: operador (Larissa/Duilio) também pode cadastrar/
-- editar contatos de escalonamento. Cada um cadastra os contatos da carteira
-- dele. Cadastro é colaborativo — qualquer authenticated CRUD.
--
-- Mantém visibilidade total (SELECT todos). Gestor continua podendo tudo.
-- ============================================================================

DROP POLICY IF EXISTS contatos_escal_modify ON public.contatos_escalonamento;

CREATE POLICY contatos_escal_modify
  ON public.contatos_escalonamento
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

COMMENT ON POLICY contatos_escal_modify ON public.contatos_escalonamento IS
  'Caio 2026-05-19: liberado CRUD pra qualquer authenticated (operador + gestor). '
  'Cadastro colaborativo — Larissa/Duilio cadastram contatos das próprias carteiras.';
