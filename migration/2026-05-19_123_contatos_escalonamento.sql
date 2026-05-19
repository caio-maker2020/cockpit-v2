-- ============================================================================
-- Cockpit v2 — contatos_escalonamento (PRIORIDADES AI)
-- Data: 2026-05-19
--
-- Tabela cadastral dos contatos pra cobrança escalonada:
--   - gerente_base       (1ª cobrança)
--   - coordenador_entrega (escalação)
--   - gerente_relacionamento (escalação executiva, geralmente global)
--
-- Convenção: base IS NULL → contato global (mesmo pra todas bases).
-- Lookup faz match exato 1º; fallback global. Ordenação NULLS LAST.
--
-- CRUD: gestor edita; operadores só veem (read-only).
-- ============================================================================

CREATE TABLE public.contatos_escalonamento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base text,                                   -- código SSW; NULL = global
  cargo text NOT NULL CHECK (cargo IN (
    'gerente_base','coordenador_entrega','gerente_relacionamento')),
  nome text NOT NULL,
  telefone text,                               -- formato Evolution (5535999990000)
  email text,
  ativo boolean NOT NULL DEFAULT true,
  observacao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_contatos_escal_base_cargo
  ON public.contatos_escalonamento (base, cargo) WHERE ativo;

CREATE INDEX idx_contatos_escal_cargo_global
  ON public.contatos_escalonamento (cargo) WHERE ativo AND base IS NULL;

CREATE TRIGGER contatos_escal_set_updated_at
  BEFORE UPDATE ON public.contatos_escalonamento
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.contatos_escalonamento ENABLE ROW LEVEL SECURITY;

CREATE POLICY contatos_escal_select
  ON public.contatos_escalonamento
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY contatos_escal_modify
  ON public.contatos_escalonamento
  FOR ALL TO authenticated
  USING (public.current_operador_papel() = 'gestor')
  WITH CHECK (public.current_operador_papel() = 'gestor');

COMMENT ON TABLE public.contatos_escalonamento IS
  'Contatos pra cobrança escalonada de NFs paradas em oc=13/21. '
  'base IS NULL = contato global (gerente_relacionamento típico). '
  'Edita-se em CADASTROS → Escalonamento (gestor). '
  'Lookup: SELECT WHERE cargo=$1 AND ativo AND (base=$2 OR base IS NULL) ORDER BY base NULLS LAST LIMIT 1';
