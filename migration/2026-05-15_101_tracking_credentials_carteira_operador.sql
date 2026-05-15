-- Migration 101: popular tracking_credentials pra todos clientes da carteira
-- de cada operador (caso ainda não exista).
--
-- CONTEXTO (Caio 2026-05-15):
-- Aba CADASTROS do Lovable lista rows de `tracking_credentials` (subtítulo
-- "CLIENTES RASTREADOS PELO COCKPIT"). Como tracking público foi deprecated
-- (Fase 3 plano "hoje-usamos-o-bastao"), novos operadores entram com 0
-- tracking_credentials e a aba aparece vazia mesmo com carteira populada.
--
-- Fix: cada CNPJ na carteira de operador ativo deve ter row stub em
-- tracking_credentials (senha NULL, ativo=true). Operador vê clientes;
-- SSW interno (101) cobre 100% da operação, senha não é mais necessária.
--
-- Idempotente via ON CONFLICT.

INSERT INTO public.tracking_credentials (documento, nome_amigavel, senha, ativo, operador_responsavel_id, notes)
SELECT
  c.cnpj_cpf,
  c.nome,
  NULL,
  true,
  op.id,
  'Auto-gerado por migration 101 (Caio 2026-05-15) — tracking público deprecated; SSW interno cobre. Senha NULL.'
FROM public.operadores op
CROSS JOIN LATERAL unnest(op.carteira) AS cnpj_op(cnpj)
JOIN public.clientes c ON c.cnpj_cpf = cnpj_op.cnpj
WHERE op.ativo = true AND op.cockpit_ativo = true
ON CONFLICT (documento) DO NOTHING;

-- Cobertura pra próximos operadores: o script de onboarding
-- (scripts/import_<nome>.py) também deve criar tracking_credentials pra cada
-- cliente importado. Memory [[separacao-operador-cliente-global]] + playbook
-- onboarding atualizados.
