-- =============================================================================
-- 2026-06-16 — offboarding total do CARLOS (clientes liberados pra cadastro)
-- =============================================================================
-- Contexto: CARLOS desativado no reorg 2026-06-15 (cockpit_ativo=false +
-- ativo=false), mas ainda figurava como "dono" de:
--   - 78 contatos_cliente.operador_responsavel_id = CARLOS (ativos)
--   - 51 tracking_credentials.operador_responsavel_id = CARLOS (ativos)
--
-- Operadores ativos (ISA E KAROL, DUILIO, etc.) tentavam cadastrar clientes
-- que pertenciam ao CARLOS e batiam na RPC cadastrar_cliente_completo no gate
-- "Cliente X já está cadastrado pra outro operador" (mig 102).
--
-- Caso âncora: ISA E KAROL tentou cadastrar 12377080000188 (Atacado União) —
-- bloqueada porque tracking_credentials.operador_responsavel_id=CARLOS.
--
-- Decisão Caio 2026-06-16: como CARLOS não existe mais, libera TUDO de uma vez.
-- Clientes ficam "órfãos" (operador_responsavel_id=NULL, ativo=false) até
-- algum operador ativo cadastrar pra si (RPC então upsert pra ele).
--
-- Mudança de schema: operador_responsavel_id passa a ser nullable em ambas as
-- tabelas — semântica "cliente sem dono" passa a ser legítima (até hoje
-- significava só "registro inválido").
--
-- Gate da RPC `cadastrar_cliente_completo` (mig 102) JÁ trata NULL corretamente:
--   IF v_existing_operador IS NOT NULL AND v_existing_operador <> v_target THEN
--     RAISE EXCEPTION '...';
--   END IF;
-- Quando operador_responsavel_id=NULL, gate passa direto → qualquer operador
-- pode reivindicar o cliente.
-- =============================================================================

-- 1. ALTER schema: nullable + manter NOT VALID se quiser checks futuros
ALTER TABLE public.tracking_credentials
  ALTER COLUMN operador_responsavel_id DROP NOT NULL;

ALTER TABLE public.contatos_cliente
  ALTER COLUMN operador_responsavel_id DROP NOT NULL;

COMMENT ON COLUMN public.tracking_credentials.operador_responsavel_id IS
  'Operador "dono" do cliente. NULL = cliente órfão (operador anterior desativado, '
  'aguardando reivindicação por operador novo). Gate em cadastrar_cliente_completo '
  'permite qualquer operador assumir órfãos. Caio 2026-06-16: tornei nullable no '
  'offboarding total do CARLOS (mig 207).';

COMMENT ON COLUMN public.contatos_cliente.operador_responsavel_id IS
  'Operador "dono" do contato. NULL = contato órfão (operador anterior desativado). '
  'Cadastros novos sobrescrevem (RPC DELETE FROM contatos_cliente WHERE documento_cliente=X). '
  'Caio 2026-06-16: nullable desde mig 207.';

-- 2. Libera contatos_cliente do CARLOS
DO $$
DECLARE
  v_carlos_id uuid;
  v_contatos int;
  v_tracking int;
BEGIN
  SELECT id INTO v_carlos_id FROM public.operadores WHERE nome = 'CARLOS' LIMIT 1;
  IF v_carlos_id IS NULL THEN
    RAISE NOTICE 'CARLOS não encontrado — nada a liberar';
    RETURN;
  END IF;

  -- Contatos: órfanos + inativos (preserva histórico)
  UPDATE public.contatos_cliente
  SET operador_responsavel_id = NULL,
      ativo = false,
      observacao = COALESCE(observacao || ' | ', '') ||
        'offboarded mig 207: CARLOS desativado 2026-06-15',
      updated_at = now()
  WHERE operador_responsavel_id = v_carlos_id;
  GET DIAGNOSTICS v_contatos = ROW_COUNT;

  -- Tracking credentials: órfanos + inativos
  UPDATE public.tracking_credentials
  SET operador_responsavel_id = NULL,
      ativo = false,
      notes = COALESCE(notes || ' | ', '') ||
        'offboarded mig 207: CARLOS desativado 2026-06-15'
  WHERE operador_responsavel_id = v_carlos_id;
  GET DIAGNOSTICS v_tracking = ROW_COUNT;

  RAISE NOTICE 'mig 207 offboarding CARLOS: % contatos + % tracking_credentials liberados (operador_responsavel_id=NULL, ativo=false)',
    v_contatos, v_tracking;
END $$;

-- 3. Sanity: nada mais aponta pro CARLOS
DO $$
DECLARE
  v_carlos_id uuid;
  v_residual_contatos int;
  v_residual_tracking int;
BEGIN
  SELECT id INTO v_carlos_id FROM public.operadores WHERE nome = 'CARLOS' LIMIT 1;
  IF v_carlos_id IS NULL THEN RETURN; END IF;

  SELECT COUNT(*) INTO v_residual_contatos
    FROM public.contatos_cliente WHERE operador_responsavel_id = v_carlos_id;
  SELECT COUNT(*) INTO v_residual_tracking
    FROM public.tracking_credentials WHERE operador_responsavel_id = v_carlos_id;

  IF v_residual_contatos > 0 OR v_residual_tracking > 0 THEN
    RAISE EXCEPTION 'mig 207 falhou: residual contatos=%, tracking=%', v_residual_contatos, v_residual_tracking;
  END IF;
END $$;
