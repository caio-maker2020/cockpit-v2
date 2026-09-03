-- =============================================================================
-- 2026-09-03_379 — cliente_config_seguir_parcial_auto: whitelist da oc 55 automática
-- =============================================================================
-- ADR 0025. Caio 03/09 (briefing 55_EXTRAVIOS E AVARIAS.txt): clientes que
-- autorizam EM CADASTRO seguir parcial mesmo com avaria (oc 08) ou extravio
-- parcial (oc 06). Para esses CNPJs o Cockpit lança a oc 55 sozinho, sem
-- perguntar ao cliente e sem esperar o operador.
--
-- Molde: cliente_config_oc13 (mig 121) — cada exceção operacional tem sua
-- tabela dedicada, auditável e fácil de desmontar isoladamente. NÃO reusa
-- cliente_config (que é config de romaneio/indenização, semântica diferente).
--
-- TIPO B (política de migrations, docs/POLITICA_MIGRATIONS.md) — exige
-- --autorizado-por. Eu havia rotulado TIPO A por engano; o classificador do
-- `scripts/dbq.py` acusa **"DROP de objeto"**: os `DROP TRIGGER IF EXISTS` e
-- `DROP POLICY IF EXISTS` abaixo. Ambos recaem sobre objetos criados NESTA
-- MESMA migration (padrão drop-then-create pra idempotência), então o risco
-- real é zero — mas a política manda: "em dúvida, tratar como TIPO B". Não
-- reclassificar no braço; declarar quem autorizou.
--
-- Por que continua inerte, apesar de TIPO B:
--   - CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS — aditivo;
--   - a flag NASCE DESLIGADA (enabled=false) — não é "flag nascendo ligada";
--   - o seed entra com ativo=FALSE nas 4 linhas — nenhum comportamento muda ao
--     aplicar esta migration. Ligar cada CNPJ é ato separado e explícito.
--   - INSERT em tabela NOVA criada nesta própria migration, sem efeito
--     operacional enquanto ativo=false.
-- Reversível: DROP TABLE + DELETE da flag.
--
-- skill supabase-postgres-best-practices: NÃO estava instalada nesta sessão
-- (registrado no ADR 0025). Regras aplicadas manualmente a partir dos
-- precedentes do repo: idempotente; schema-qualified; RLS habilitada com
-- policy RESTRICTIVE negando anon/authenticated (service_role apenas, como a
-- cliente_config_oc13); CHECK de 14 dígitos no CNPJ; índice parcial em ativo;
-- trigger de updated_at reusando public.set_updated_at(); sem SECURITY DEFINER
-- novo; sem view (logo, sem risco de perder security_invoker); transação única
-- e curta.
--
-- ⚠ Blast radius ao APLICAR: ZERO. Tabela nova + flag OFF + 4 linhas inativas.
-- ⚠ Blast radius ao ATIVAR (ato posterior, TIPO B): os cards de oc 06/08 desses
--   CNPJs passam a receber oc 55 autônoma. Medição da F0 (2026-09-03, 180 dias):
--   23 cards de oc 06 e ~20 de oc 08 no período; 8 cards ativos hoje em
--   EXTRAVIO_MONITORADO. Ativar 1 CNPJ por vez, após o shadow (F7).
-- ⚠ SEM BEGIN/COMMIT interno (política de migrations, regra 13/08): o
-- `scripts/dbq.py` já envolve o arquivo na transação dele. Um COMMIT aqui
-- encerraria a transação externa e o ROLLBACK do --dry-run viraria no-op —
-- tudo persistiria (caso real: mig 337, 13/08).
-- =============================================================================

-- 1. Whitelist ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cliente_config_seguir_parcial_auto (
  cnpj_pagador text PRIMARY KEY,
  nome_cliente text NOT NULL,
  -- Nasce FALSE de propósito: aplicar a migration não liga nada.
  ativo boolean NOT NULL DEFAULT false,
  -- Escopo por ocorrência, para ligar avaria antes de extravio (ou vice-versa)
  -- sem precisar de migration nova.
  aplica_oc06 boolean NOT NULL DEFAULT true,
  aplica_oc08 boolean NOT NULL DEFAULT true,
  -- Quem autorizou e quando — a autorização é do CLIENTE, precisa ser rastreável.
  autorizado_por text,
  autorizado_em date,
  observacao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cliente_config_seguir_parcial_cnpj_digits
    CHECK (cnpj_pagador ~ '^\d{14}$')
);

-- Índice parcial: o lookup do agente é sempre "quais estão ativos".
CREATE INDEX IF NOT EXISTS idx_cliente_config_seguir_parcial_ativo
  ON public.cliente_config_seguir_parcial_auto (cnpj_pagador) WHERE ativo;

DROP TRIGGER IF EXISTS cliente_config_seguir_parcial_set_updated_at
  ON public.cliente_config_seguir_parcial_auto;
CREATE TRIGGER cliente_config_seguir_parcial_set_updated_at
  BEFORE UPDATE ON public.cliente_config_seguir_parcial_auto
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.cliente_config_seguir_parcial_auto ENABLE ROW LEVEL SECURITY;

-- Mesma política da cliente_config_oc13: service_role apenas. As edge functions
-- rodam com service_role; gestão por SQL via trilho (scripts/dbq.py).
DROP POLICY IF EXISTS cliente_config_seguir_parcial_service_only
  ON public.cliente_config_seguir_parcial_auto;
CREATE POLICY cliente_config_seguir_parcial_service_only
  ON public.cliente_config_seguir_parcial_auto
  AS RESTRICTIVE TO anon, authenticated
  USING (false);

COMMENT ON TABLE public.cliente_config_seguir_parcial_auto IS
  'ADR 0025 (Caio 2026-09-03): CNPJs que autorizam EM CADASTRO seguir parcial '
  'com avaria (oc 08) ou extravio parcial (oc 06). Para esses clientes o Cockpit '
  'lança a oc 55 autonomamente, sem notificar nem pedir autorização. '
  'ativo=false por default — ligar 1 CNPJ por vez após o shadow. Gestão via SQL.';
COMMENT ON COLUMN public.cliente_config_seguir_parcial_auto.aplica_oc06 IS
  'Liga a regra para extravio (oc 06). Só vale quando NÃO há sinal de extravio '
  'total — ver D2 do ADR 0025 (palavra TOTAL OU qtd lida >= volumes da NF).';
COMMENT ON COLUMN public.cliente_config_seguir_parcial_auto.aplica_oc08 IS
  'Liga a regra para avaria na transferência (oc 08). Sem condição extra.';
COMMENT ON COLUMN public.cliente_config_seguir_parcial_auto.autorizado_por IS
  'Quem no cliente deu a autorização permanente. Rastreabilidade: a 55 é '
  'lançada em nome dessa autorização e ocorrência no SSW não tem desfazer.';

-- 2. Kill-switch sem deploy --------------------------------------------------
-- Nasce OFF. Mesmo com CNPJ ativo=true, nada roda enquanto a flag estiver OFF.
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'seguir_parcial_auto_enabled',
  false,
  'ADR 0025: liga a oc 55 automática para os CNPJs em '
  'cliente_config_seguir_parcial_auto (ativo=true). OFF = comportamento atual '
  'para todo mundo. Kill-switch sem deploy.'
)
ON CONFLICT (key) DO NOTHING;

-- 3. Seed — 4 CNPJs do briefing, TODOS INATIVOS -------------------------------
-- Carteira conferida em produção na F0 (2026-09-03): DUILIO 1, FELIPE 3.
-- ativo=false: entram no cadastro mas não mudam nada até ordem explícita.
INSERT INTO public.cliente_config_seguir_parcial_auto
  (cnpj_pagador, nome_cliente, ativo, autorizado_por, autorizado_em, observacao)
VALUES
  ('13309775000195', 'TOTALL DISTRIBUIDORA ATACADIST',      false, 'Caio (briefing 03/09)', '2026-09-03', 'Carteira DUILIO. Aguardando shadow (F7) antes de ativar.'),
  ('04098359000366', 'GMI DISTRIBUIDORA LTDA',              false, 'Caio (briefing 03/09)', '2026-09-03', 'Carteira FELIPE. Aguardando shadow (F7) antes de ativar.'),
  ('04098359000102', 'GMI DISTRIBUIDORA LTDA',              false, 'Caio (briefing 03/09)', '2026-09-03', 'Carteira FELIPE. Aguardando shadow (F7) antes de ativar.'),
  ('26013236000156', 'DISTRIB MINEIRA DE FILTROS AUT LTDA', false, 'Caio (briefing 03/09)', '2026-09-03', 'Carteira FELIPE. Aguardando shadow (F7) antes de ativar.')
ON CONFLICT (cnpj_pagador) DO NOTHING;

-- 4. Smoke test inline --------------------------------------------------------
DO $$
DECLARE
  v_linhas integer;
  v_ativos integer;
  v_flag boolean;
BEGIN
  SELECT count(*) INTO v_linhas FROM public.cliente_config_seguir_parcial_auto;
  IF v_linhas < 4 THEN
    RAISE EXCEPTION 'Seed falhou: esperado >= 4 CNPJs, encontrado %', v_linhas;
  END IF;

  -- INV-142: nada pode nascer ligado.
  SELECT count(*) INTO v_ativos
    FROM public.cliente_config_seguir_parcial_auto WHERE ativo;
  IF v_ativos <> 0 THEN
    RAISE EXCEPTION 'INV-142 violado: % CNPJ(s) nasceram ativos — o seed deve ser inerte', v_ativos;
  END IF;

  SELECT enabled INTO v_flag
    FROM public.feature_flags WHERE key = 'seguir_parcial_auto_enabled';
  IF v_flag IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'INV-142 violado: flag seguir_parcial_auto_enabled deveria nascer OFF (valor=%)', v_flag;
  END IF;
END $$;
