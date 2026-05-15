-- Migration 100: RLS de clientes filtra por carteira do operador.
--
-- CONTEXTO (Caio 2026-05-15):
-- Aba CADASTROS do Duilio aparece vazia E aba AUDITORIA mostra clientes
-- de outros operadores. Causa: policy `clientes_select_authenticated`
-- estava `USING (true)` — qualquer operador vê todos os 228 clientes
-- (Larissa + Duilio).
--
-- Regra Caio (global, aplicar SEMPRE):
--   "Separação é sempre por operador e cliente. Nunca deve aparecer um
--   cliente na plataforma de outro operador."
--
-- Fix: SELECT em `clientes` só retorna:
--   - papel = 'gestor' → vê tudo (Caio admin)
--   - operador → só clientes cujo cnpj_cpf está na sua carteira
--                (current_operador_carteira())
--
-- Premissa: 1 CNPJ = 1 operador (validado: overlap Larissa↔Duilio = 0).
--
-- Edge functions internas usam service_role → bypass RLS. Nenhuma quebra.
-- Front Lovable (autenticado como operador) passa a ver só clientes próprios
-- automaticamente sem precisar filtrar na query.

DROP POLICY IF EXISTS clientes_select_authenticated ON public.clientes;

CREATE POLICY clientes_select_por_carteira ON public.clientes
  FOR SELECT TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR cnpj_cpf = ANY(public.current_operador_carteira())
  );

COMMENT ON POLICY clientes_select_por_carteira ON public.clientes IS
  'Operador vê SÓ clientes da sua carteira; gestor vê tudo. Caio 2026-05-15: '
  'regra global de separação por operador (aba CADASTROS Duilio aparecia vazia '
  'e aba AUDITORIA mostrava clientes da Larissa).';
