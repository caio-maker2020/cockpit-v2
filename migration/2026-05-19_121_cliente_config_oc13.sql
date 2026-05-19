-- ============================================================================
-- Cockpit v2 — cliente_config_oc13: exceção "tratar oc=13 no Cockpit"
-- Data: 2026-05-19
--
-- Caio: 6 clientes (12 CNPJs) que obrigam a notificar o cliente final ANTES
-- de seguir pra entrega mesmo nos casos de oc=13. Quebra a regra geral
-- (oc=13 = responsabilidade do cliente final, sem tratativa de relacionamento).
--
-- Cards com oc=13 desses CNPJs entram no Cockpit em AGUARDANDO_VALIDACAO_HUMANA
-- + lock=true, com propostas auto (56, 21, 41, 54). Operador trata como
-- relacionamento normal. Caso âncora: NF que fica pendurada na operação porque
-- o CTRC de reentrega não foi emitido auto (regra interna desses clientes) —
-- operador precisa lançar 21 pelo Cockpit, que aí destrava a emissão.
--
-- NÃO é o mesmo `cliente_config` da PRATI. Cada exceção operacional tem sua
-- tabela dedicada — fica auditável e fácil de desmontar isoladamente.
--
-- Gestão exclusiva via SQL (sem CRUD no Lovable, intencional — Caio prefere
-- mais segurança vs ergonomia, exceções são raras: ~2-3 por go-live novo).
-- Doc de operação: docs/operacoes/cliente_config_oc13.md.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.cliente_config_oc13 (
  cnpj_pagador text PRIMARY KEY,
  nome_cliente text NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  observacao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cliente_config_oc13_cnpj_digits CHECK (cnpj_pagador ~ '^\d{14}$')
);

CREATE INDEX IF NOT EXISTS idx_cliente_config_oc13_ativo
  ON public.cliente_config_oc13(ativo) WHERE ativo;

CREATE TRIGGER cliente_config_oc13_set_updated_at
  BEFORE UPDATE ON public.cliente_config_oc13
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.cliente_config_oc13 ENABLE ROW LEVEL SECURITY;

-- Mesma política do cliente_config da PRATI: service_role apenas.
-- Edge functions (sync-bastao, regras-auto-acao) já rodam com service_role.
-- Gestão (INSERT/UPDATE) feita por Caio via psql/Supabase SQL editor.
DROP POLICY IF EXISTS cliente_config_oc13_service_only ON public.cliente_config_oc13;
CREATE POLICY cliente_config_oc13_service_only ON public.cliente_config_oc13
  AS RESTRICTIVE TO anon, authenticated
  USING (false);

COMMENT ON TABLE public.cliente_config_oc13 IS
  'Caio 2026-05-19: lista de CNPJs cujas oc=13 viram caso de relacionamento '
  'no Cockpit (em vez de seguir o padrão "operação trata"). Cards desses '
  'CNPJs com oc=13 entram em AGUARDANDO_VALIDACAO_HUMANA com propostas auto. '
  'Gestão via SQL — sem CRUD no Lovable.';

-- ============================================================================
-- Seed inicial (12 CNPJs em 4 grupos)
-- ============================================================================

INSERT INTO public.cliente_config_oc13 (cnpj_pagador, nome_cliente, observacao) VALUES
  ('10854165000427', 'F E F DISTRIBUIDORA DE PRODUTO A1',     'Exceção oc=13: obriga notificar cliente antes de seguir'),
  ('60665981000541', 'UNIAO QUIMICA FARM NACIONAL SA A1',     'Exceção oc=13: obriga notificar cliente antes de seguir'),
  ('60665981000975', 'UNIAO QUIMICA FARMACEUTICA NAC A1',     'Exceção oc=13: obriga notificar cliente antes de seguir'),
  ('76635689000192', 'O.V.D. IMPORTADORA E DISTRIBUIDORA',    'Exceção oc=13: obriga notificar cliente antes de seguir'),
  ('76635689001245', 'O.V.D. IMPORTADORA E DISTRIBUIDORA',    'Exceção oc=13: obriga notificar cliente antes de seguir'),
  ('76635689001598', 'O.V.D. IMPORTADORA E DISTRIBUIDORA',    'Exceção oc=13: obriga notificar cliente antes de seguir'),
  ('76635689001830', 'O.V.D. IMPORTADORA E DISTRIBUIDORA',    'Exceção oc=13: obriga notificar cliente antes de seguir'),
  ('76635689002306', 'O.V.D. IMPORTADORA E DISTRIBUIDORA',    'Exceção oc=13: obriga notificar cliente antes de seguir'),
  ('92664028000656', 'FERRAMENTAS GERAIS COM E IMP A3',       'Exceção oc=13: obriga notificar cliente antes de seguir'),
  ('92664028002438', 'FERRAMENTAS GERAIS COM E IMP A3',       'Exceção oc=13: obriga notificar cliente antes de seguir'),
  ('92664028002519', 'FERRAMENTAS GERAIS COM E IMP A3',       'Exceção oc=13: obriga notificar cliente antes de seguir'),
  ('92664028002780', 'FERRAMENTAS GERAIS COM E IMP A3',       'Exceção oc=13: obriga notificar cliente antes de seguir')
ON CONFLICT (cnpj_pagador) DO NOTHING;

-- Smoke test inline
DO $$
DECLARE
  v_qt integer;
BEGIN
  SELECT COUNT(*) INTO v_qt FROM public.cliente_config_oc13 WHERE ativo;
  IF v_qt < 12 THEN
    RAISE EXCEPTION 'Seed inicial falhou: esperado >= 12 CNPJs ativos, encontrado %', v_qt;
  END IF;
END $$;
