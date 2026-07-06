-- =============================================================================
-- 2026-06-25_266 — Gerente de relacionamento ISADORA BALDONI (papel=gestor)
-- =============================================================================
-- Caio 2026-06-25: criar login pra gerente de relacionamento (responsável pelos
-- operadores), com acesso admin igual ao do Caio.
--
-- "Acesso admin" = 2 camadas:
--   1. papel='gestor' → RLS dá visibilidade TOTAL (vê todos os cards/operadores,
--      gestor-only policies e RPCs). É o que esta migration faz.
--   2. SUPER_ADMINS em supabase/functions/admin-operadores/index.ts → painel de
--      criar/resetar login de operador. isadora.baldoni@ adicionada lá + deploy
--      (fora desta migration).
--
-- Espelha a linha do Caio: papel=gestor, ativo=true, cockpit_ativo=false (gestor
-- não precisa de carteira/segmento — vê tudo pela RLS de gestor).
--
-- Auth (já criado via Admin API, fora da migration):
--   CREATE isadora.baldoni@salexpress.com.br -> 2cc8380c-8cb6-4608-98ec-62596ea324d7
--
-- skill: supabase-postgres-best-practices — idempotente (ON CONFLICT nome).
-- =============================================================================
BEGIN;

INSERT INTO public.operadores
  (nome, email, email_relacionamento, papel, segmentos, carteira, cockpit_ativo, ativo, user_id)
VALUES
  ('Isadora Baldoni', 'isadora.baldoni@salexpress.com.br', 'isadora.baldoni@salexpress.com.br',
   'gestor', '{}'::text[], '{}'::text[], false, true,
   '2cc8380c-8cb6-4608-98ec-62596ea324d7')
ON CONFLICT (nome) DO UPDATE SET
  email=EXCLUDED.email, email_relacionamento=EXCLUDED.email_relacionamento,
  papel='gestor', ativo=true, user_id=EXCLUDED.user_id;

COMMIT;
