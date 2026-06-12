-- ============================================================================
-- Cockpit v2 — contatos_escalonamento: cargo 'time_ressarcimento' adicionado
-- ao CHECK. Usado pelo agente-sugere-ocs-padrao no Caso 1c (oc=49 sem qtd
-- de volumes extraviados extraída) pra disparar WhatsApp autônomo via
-- Evolution API.
-- Data: 2026-05-29
-- skill: supabase-postgres-best-practices
--
-- Mesma estrutura (nome + telefone Evolution) das outras escalações.
-- Caio cadastra depois via SQL/UI:
--   INSERT INTO public.contatos_escalonamento (cargo, nome, telefone)
--   VALUES ('time_ressarcimento', 'NOME', '5535999990000');
--
-- skill checklist:
--   - DROP + ADD CONSTRAINT (idempotente pra Postgres não aceita IF NOT EXISTS
--     em check constraint nominado) ✓
--   - Sem impacto em RLS/policy/index existentes ✓
--   - Comment atualizado ✓
-- ============================================================================

ALTER TABLE public.contatos_escalonamento
  DROP CONSTRAINT IF EXISTS contatos_escalonamento_cargo_check;

ALTER TABLE public.contatos_escalonamento
  ADD CONSTRAINT contatos_escalonamento_cargo_check
  CHECK (cargo IN (
    'gerente_base',
    'coordenador_entrega',
    'gerente_relacionamento',
    'time_ressarcimento'
  ));

COMMENT ON COLUMN public.contatos_escalonamento.cargo IS
  'Caio 2026-05-29: cargo time_ressarcimento adicionado pra agente oc=49 '
  'Caso 1c (WPP autônomo quando qtd de volumes extraviados não é identificada '
  'no SSW). Mesma estrutura nome+telefone Evolution das demais escalações.';
