-- =============================================================================
-- 2026-07-28_313 — Limiar configurável do agente autônomo de extravio (oc 49)
-- =============================================================================
-- Duílio 2026-07-28: hoje o agente-extravio-d4 lança a oc 49 pra TODOS no D4
-- (dias_uteis >= 4, hardcoded `coluna_kanban="D4"`). Pedido:
--   - FELIPE (auto.pecas): D2 pra TODOS os clientes da carteira dele;
--   - LARISSA / cliente PRATI (CNPJ 73856593001057): D2;
--   - resto do time: segue D4 (default).
--
-- Vira config: limiar POR OPERADOR (default 4) + override POR CLIENTE. O agente
-- resolve por card: cliente > operador > 4 (o mais específico vence) e lança
-- quando dias_uteis >= limiar. O kanban do front (coluna D1/D2/D3/D4 por dias
-- reais) NÃO muda — só a elegibilidade do robô.
--
-- skill: supabase-postgres-best-practices (aplicada manualmente — pacote não
-- instalado): idempotente (ADD COLUMN IF NOT EXISTS); DEFAULT explícito no
-- operador (nenhuma linha fica sem limiar); NULL no cliente = "sem override";
-- CHECK de sanidade (1..30) pra não lançar dia 0 ou limiar absurdo; sem RLS nova
-- (colunas em tabelas já existentes; o agente lê via service_role). ⚠ Blast
-- radius: ao ligar FELIPE em D2, os extravios dele que já estão em D2/D3
-- (esperando D4) viram elegíveis DE UMA VEZ — rajada de lançamentos autônomos
-- no 1º ciclo (Duílio ciente).
-- =============================================================================
BEGIN;

-- 1. Limiar por operador (default 4 = comportamento atual pra todo mundo).
ALTER TABLE public.operadores
  ADD COLUMN IF NOT EXISTS dias_autonomo_extravio smallint NOT NULL DEFAULT 4;

ALTER TABLE public.operadores
  DROP CONSTRAINT IF EXISTS chk_operadores_dias_autonomo_extravio;
ALTER TABLE public.operadores
  ADD CONSTRAINT chk_operadores_dias_autonomo_extravio
  CHECK (dias_autonomo_extravio BETWEEN 2 AND 30);

COMMENT ON COLUMN public.operadores.dias_autonomo_extravio IS
  'Dia útil a partir do qual o agente-extravio-d4 lança a oc 49 autônoma pros '
  'cards deste operador. Default 4 (D4). FELIPE=2 (Duílio 2026-07-28). '
  'Override por cliente em cliente_config.dias_autonomo_extravio.';

-- 2. Override por cliente (NULL = sem override, usa o do operador).
ALTER TABLE public.cliente_config
  ADD COLUMN IF NOT EXISTS dias_autonomo_extravio smallint;

ALTER TABLE public.cliente_config
  DROP CONSTRAINT IF EXISTS chk_cliente_config_dias_autonomo_extravio;
ALTER TABLE public.cliente_config
  ADD CONSTRAINT chk_cliente_config_dias_autonomo_extravio
  CHECK (dias_autonomo_extravio IS NULL OR dias_autonomo_extravio BETWEEN 2 AND 30);

COMMENT ON COLUMN public.cliente_config.dias_autonomo_extravio IS
  'Override do limiar de lançamento autônomo da oc 49 para este cliente '
  '(cnpj_pagador). NULL = usa o do operador. PRATI 73856593001057 = 2 '
  '(Duílio 2026-07-28). Vence o do operador.';

-- 3. Os 2 ajustes pedidos.
UPDATE public.operadores SET dias_autonomo_extravio = 2 WHERE upper(nome) = 'FELIPE';
UPDATE public.cliente_config SET dias_autonomo_extravio = 2 WHERE cnpj_pagador = '73856593001057';

COMMIT;
