-- Migration 099: FK contatos_cliente → clientes (necessária pra PostgREST embedding).
--
-- CONTEXTO (Caio 2026-05-15, onboarding Duilio):
-- Aba CADASTROS do Lovable usa `select=clientes(*,contatos_cliente(*))` que
-- depende de FK explícita. Sem FK, PostgREST retorna PGRST200 e tela fica
-- vazia. Limpeza de órfãos foi feita inline antes do ALTER (3 contatos da
-- Larissa: 1 CNPJ 13→14 dígitos via zero-padding, 2 stubs em clientes).

-- Idempotente: ALTER falha se FK já existe; cobrir via IF condicional.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contatos_cliente_documento_cliente_fkey'
  ) THEN
    ALTER TABLE public.contatos_cliente
      ADD CONSTRAINT contatos_cliente_documento_cliente_fkey
      FOREIGN KEY (documento_cliente) REFERENCES public.clientes(cnpj_cpf) ON DELETE CASCADE;
  END IF;
END$$;

COMMENT ON CONSTRAINT contatos_cliente_documento_cliente_fkey ON public.contatos_cliente IS
  'FK pra PostgREST detectar relationship clientes ↔ contatos_cliente. '
  'Aba CADASTROS do Lovable depende dessa FK pro embed contatos_cliente(*) '
  'funcionar. Caio 2026-05-15 (bug aba CADASTROS Duilio vazia).';
