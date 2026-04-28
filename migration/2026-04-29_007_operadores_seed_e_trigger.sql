-- ============================================================================
-- Cockpit v2 — Operadores como entidade independente de auth.users
-- Data: 2026-04-29
--
-- Motivos:
--  - Bastão referencia operadores por nome (responsavel_relacionamento).
--  - Queremos exibir o nome no card mesmo antes de o operador ter login Supabase.
--  - Quando um operador for promovido a usuário, basta UPDATE user_id.
-- ============================================================================

-- ============================================================================
-- 1. user_id nullable — permite carteira sem login
-- ============================================================================
ALTER TABLE public.operadores ALTER COLUMN user_id DROP NOT NULL;

-- ============================================================================
-- 2. UNIQUE em nome (case-sensitive — usamos UPPER convention pra match Bastão)
-- ============================================================================
ALTER TABLE public.operadores ADD CONSTRAINT operadores_nome_unique UNIQUE (nome);

-- ============================================================================
-- 3. Seed dos 7 operadores que aparecem hoje no Bastão como responsáveis
-- ============================================================================
INSERT INTO public.operadores (nome, email, papel, carteira, ativo) VALUES
  ('TULIO',   'tulio@salexpress.com.br',   'operador', '{}'::text[], true),
  ('INGRID',  'ingrid@salexpress.com.br',  'operador', '{}'::text[], true),
  ('CAMILA',  'camila@salexpress.com.br',  'operador', '{}'::text[], true),
  ('MARIA',   'maria@salexpress.com.br',   'operador', '{}'::text[], true),
  ('DUILIO',  'duilio@salexpress.com.br',  'operador', '{}'::text[], true),
  ('VICTOR',  'victor@salexpress.com.br',  'operador', '{}'::text[], true),
  ('LARISSA', 'larissa@salexpress.com.br', 'operador', '{}'::text[], true)
ON CONFLICT (nome) DO NOTHING;

-- ============================================================================
-- 4. Trigger: auto-popula cards.assigned_operator_id a partir do nome em
--    responsavel_relacionamento. Funciona em INSERT (sync-bastao) e em UPDATE
--    quando Bastão troca o responsável.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.resolve_assigned_operator_from_name()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.assigned_operator_id IS NULL
     AND NEW.responsavel_relacionamento IS NOT NULL
     AND length(trim(NEW.responsavel_relacionamento)) > 0
  THEN
    SELECT id INTO NEW.assigned_operator_id
    FROM public.operadores
    WHERE upper(nome) = upper(trim(NEW.responsavel_relacionamento))
      AND ativo = true
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cards_resolve_operator
  BEFORE INSERT OR UPDATE OF responsavel_relacionamento ON public.cards
  FOR EACH ROW EXECUTE FUNCTION public.resolve_assigned_operator_from_name();

-- ============================================================================
-- 5. Backfill — popula assigned_operator_id pros 38 cards já importados
--    (trigger só dispara em INSERT/UPDATE futuros)
-- ============================================================================
UPDATE public.cards
SET assigned_operator_id = (
  SELECT id FROM public.operadores
  WHERE upper(nome) = upper(trim(public.cards.responsavel_relacionamento))
    AND ativo = true
  LIMIT 1
)
WHERE assigned_operator_id IS NULL
  AND responsavel_relacionamento IS NOT NULL
  AND length(trim(responsavel_relacionamento)) > 0;
