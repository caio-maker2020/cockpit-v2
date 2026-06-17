-- =============================================================================
-- Aba EXTRAVIOS no Cockpit — infraestrutura (FASE 1, visual + 3 ações)
--
-- Caio 2026-06-17: dar ao time de Relacionamento VISÃO dos extravios (oc 6/9/16
-- = responsabilidade Perdas) dos seus clientes, num kanban por dias úteis desde
-- o lançamento da última ocorrência. Teste só no operador DUILIO.
--
-- O card é dirigido pela ocorrência atual: oc∈{6,9,16} → aba EXTRAVIOS; quando
-- vira 49/54 (ação do operador) ou 20 (localizado pelo Perdas) → última oc passa
-- a ser Relacionamento → card sai do kanban e entra no fluxo normal. O "mover de
-- aba" é automático via estado/oc + filtros das views.
--
-- Esta migration NÃO ativa nada sozinha: o pull é feito pela edge function
-- sync-extravios-bastao, gated por feature_flags.extravios_cockpit_enabled (OFF).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Novo estado EXTRAVIO_MONITORADO
--
-- Separa cards de extravio das abas de relacionamento: a aba TRATATIVAS filtra
-- state NOT IN (...,'EXTRAVIO_MONITORADO') e a aba EXTRAVIOS filtra exatamente
-- este estado. Nenhum agente/cron de relacionamento o processa (todos filtram
-- seus próprios estados), então não há conflito de regras.
-- ----------------------------------------------------------------------------
ALTER TABLE public.cards DROP CONSTRAINT IF EXISTS cards_state_check;
ALTER TABLE public.cards ADD CONSTRAINT cards_state_check CHECK (
  state = ANY (ARRAY[
    'RECEBIDO','EM_TRIAGEM','AGUARDANDO_VINCULACAO','AGUARDANDO_CONTEXTO',
    'AGUARDANDO_AGENTE','EM_EXECUCAO_AUTOMATICA','AGUARDANDO_VALIDACAO_HUMANA',
    'EXECUTANDO_ACAO','ACAO_EXECUTADA','AGUARDANDO_CLIENTE','AGUARDANDO_TERCEIRO',
    'BLOQUEADO_POR_ERRO','ESCALADO_HUMANO','TRANSFERIDO','TRATATIVA_PENDENTE',
    'EXTRAVIO_MONITORADO',
    'RESOLVIDO','CANCELADO'
  ])
);

-- Índice parcial pra a view do kanban (cards de extravio ativos).
CREATE INDEX IF NOT EXISTS idx_cards_extravio_monitorado
  ON public.cards(cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia)
  WHERE state = 'EXTRAVIO_MONITORADO';

-- ----------------------------------------------------------------------------
-- 2. Feature flag (OFF) — gate do teste (só DUILIO no edge function)
-- ----------------------------------------------------------------------------
INSERT INTO public.feature_flags (key, description, enabled) VALUES
  ('extravios_cockpit_enabled',
   'Liga o pull de extravios (oc 6/9/16) pro Cockpit via sync-extravios-bastao. '
   'Teste só no operador DUILIO. OFF = nenhum card de extravio é criado.',
   false)
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. VIEW v_extravios_kanban — kanban D1..D5 por dias ÚTEIS
--
-- Espelha o padrão de v_prioridades_ai: security_invoker=on (RLS de cards →
-- Duilio vê só os dele) + coluna_kanban computada. Reusa dias_uteis_entre().
-- Bucket: floor(dias úteis), mínimo 1 (lançado hoje/ontem = D1), máximo 5 (5+).
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_extravios_kanban;

CREATE VIEW public.v_extravios_kanban
WITH (security_invoker = on) AS
SELECT
  c.id AS card_id,
  c.nf,
  c.ctrc,
  COALESCE(c.base_destino, c.agent_state->>'unidade_atual') AS base_destino,
  c.empresa_cliente,
  c.pagador AS pagador_nome,
  c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
  c.agent_state->>'remetente'    AS remetente,
  c.agent_state->>'destinatario' AS destinatario,
  c.cod_ultima_ocorrencia AS oc_extravio,
  c.agent_state->>'instrucao_ultima_ocorrencia' AS instrucao,
  c.qtde_volumes,
  c.bastao_data_ultima_ocorrencia AS data_lancamento,
  c.assigned_operator_id,
  c.responsavel_relacionamento,
  -- dias úteis decorridos desde o lançamento da oc de extravio
  round(public.dias_uteis_entre(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    now()
  ), 2) AS dias_uteis,
  -- bucket D1..D5 (floor, mínimo 1, máximo 5)
  'D' || LEAST(5, GREATEST(1, FLOOR(public.dias_uteis_entre(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    now()
  ))::int)) AS coluna_kanban
FROM public.cards c
WHERE c.state = 'EXTRAVIO_MONITORADO'
  AND c.cod_ultima_ocorrencia IN (6, 9, 16)
ORDER BY public.dias_uteis_entre(
  (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
  now()
) DESC NULLS LAST;

GRANT SELECT ON public.v_extravios_kanban TO authenticated, service_role;

COMMENT ON VIEW public.v_extravios_kanban IS
  'Kanban EXTRAVIOS (aba do Duilio). Cards state=EXTRAVIO_MONITORADO + oc∈{6,9,16}. '
  'coluna_kanban = D1..D5 por dias úteis (dias_uteis_entre) desde a última oc. '
  'security_invoker=on → RLS de cards (operador vê só os seus). Caio 2026-06-17.';

-- ----------------------------------------------------------------------------
-- 4. Cron — pull de extravios a cada 30min (gated pela flag no edge function)
-- Mesmo padrão dos outros crons: vault.decrypted_secrets pro token + unschedule
-- defensivo pra rerun + timeout gentil.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('sync-extravios-bastao')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-extravios-bastao');
END $$;

SELECT cron.schedule(
  'sync-extravios-bastao',
  '*/30 * * * *',  -- a cada 30min
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/sync-extravios-bastao',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);
