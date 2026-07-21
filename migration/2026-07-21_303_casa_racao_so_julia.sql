-- =============================================================================
-- 2026-07-21_303 — Resolve conflito de carteira: CASA DA RAÇÃO só na JULIA
-- =============================================================================
-- Achado durante o /verify-cockpit do onboarding da Karoline (INV-036a): o CNPJ
-- 18977975000300 (CASA DA RAÇÃO VETERINÁRIA) estava em DUAS carteiras ativas —
-- ISA E KAROL + JULIA — conflito PRÉ-EXISTENTE (não causado pelas migs 300/301).
-- Diretriz Caio 2026-07-21: "CASA DA RAÇÃO é da Julia. Pode deixar apenas nela."
--
-- Estado verificado (read-only): os 2 cards ativos, 2 contatos e 1 tracking já
-- estão TODOS na JULIA. Só falta tirar o CNPJ da carteira do ISA E KAROL — nenhum
-- card/contato/tracking a mover. Idempotente. skill: supabase-postgres-best-practices.
-- =============================================================================
BEGIN;

DO $$
DECLARE
  v_cnpj     text := '18977975000300';
  v_isakarol uuid;
BEGIN
  SELECT id INTO v_isakarol FROM public.operadores WHERE nome = 'ISA E KAROL';
  IF v_isakarol IS NULL THEN
    RAISE EXCEPTION 'STOP: operador ISA E KAROL não encontrado';
  END IF;

  -- remove da carteira do ISA E KAROL (JULIA mantém tudo — carteira, cards, contatos, tracking)
  UPDATE public.operadores SET carteira = array_remove(carteira, v_cnpj) WHERE id = v_isakarol;

  RAISE NOTICE 'mig 303 CASA DA RAÇÃO %: removido da carteira do ISA E KAROL (Julia mantém)', v_cnpj;
END $$;

COMMIT;
