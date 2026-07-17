-- =============================================================================
-- FASE 2 do fix "fila acoes_agendadas saturada" (2026-07-16/17) — Raiz B:
-- fechar a fonte de cobranças novas com um ÚNICO ponto de estrangulamento.
--
-- ⚠️ NUMERAÇÃO: conferir contra prod (migs 292–296 aplicadas do repo antigo).
--
-- A mig 168 "desativou" a cobrança automática mas só desligou o cron; 4 portas
-- continuaram criando ações (executor inline/manual, executor relancamento_54
-- via INSERT direto, enviar-resposta x2). Resultado: fila recresceu 7 semanas
-- em silêncio até saturar a janela LIMIT 200 (~11-12/07).
--
-- Este arquivo:
--   1. Flag `cobranca_automatica_enabled` (OFF) — decisão de reativar é do Caio.
--   2. RPC `agendar_cobranca_email` vira o choke point: flag OFF → no-op logado;
--      flag ON → só agenda se o cliente TEM e-mail de cobrança resolvível
--      (cliente sem e-mail nunca mais entra na fila — era a pendência eterna).
--   3. Novo param opcional p_origem (o INSERT direto do executor:relancamento_54
--      foi convertido pro RPC e carregava `origem` no payload).
--
-- Junto com a Fase 1 (handler nunca deixa pendência eterna — deploy do
-- processar-acoes-agendadas), garante o INV-fila:
--   toda ação que falha OU avança executar_em pro futuro OU sai de 'pendente'.
-- =============================================================================

-- 1. Flag (OFF por default — padrão da casa, ver mig 259)
INSERT INTO public.feature_flags (key, description, enabled) VALUES
  ('cobranca_automatica_enabled',
   'Liga o agendamento de cobrança automática D+4 (RPC agendar_cobranca_email). '
   'OFF = RPC vira no-op (feature desativada desde a mig 168; fila saturou em '
   '07/2026 — ver mig 297). Ao religar, o RPC só agenda se o cliente tiver '
   'e-mail de cobrança em contatos_cliente.',
   false)
ON CONFLICT (key) DO NOTHING;

-- 2. RPC choke point. DROP antes do CREATE porque a assinatura ganha p_origem —
-- CREATE OR REPLACE com 4 args criaria um OVERLOAD e as chamadas de 3 args
-- continuariam caindo na função antiga (sem flag).
DROP FUNCTION IF EXISTS public.agendar_cobranca_email(uuid, text, int);

CREATE OR REPLACE FUNCTION public.agendar_cobranca_email(
  p_card_id uuid,
  p_template_id text,
  p_dias int DEFAULT 4,
  p_origem text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_pagador text;
  v_email   text;
  v_id      bigint;
BEGIN
  SELECT enabled INTO v_enabled
  FROM public.feature_flags
  WHERE key = 'cobranca_automatica_enabled';

  IF NOT coalesce(v_enabled, false) THEN
    -- Feature desativada (mig 168 / fix 2026-07-16): no-op logado, sem evento
    -- (evento por e-mail enviado seria spam — exatamente o que a Fase 4 corta).
    RAISE LOG 'agendar_cobranca_email: no-op, flag cobranca_automatica_enabled OFF (card=%, origem=%)',
      p_card_id, coalesce(p_origem, '-');
    RETURN NULL;
  END IF;

  -- Flag ON: validar ANTES de agendar. Cliente sem e-mail resolvível não pode
  -- entrar na fila — era ele que virava pendência eterna e saturava a janela.
  SELECT pagador INTO v_pagador FROM public.cards WHERE id = p_card_id;

  v_email := CASE WHEN v_pagador IS NULL THEN NULL
                  ELSE public.resolver_email_cobranca_cliente(v_pagador, 'cobranca') END;

  IF v_email IS NULL THEN
    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (p_card_id, 'CobrancaNaoAgendadaSemContato', 'system', 'agendar_cobranca_email',
            jsonb_build_object(
              'documento_cliente', v_pagador,
              'template_id', p_template_id,
              'origem', p_origem,
              'motivo', 'Cliente sem e-mail de cobrança em contatos_cliente — cobrança NÃO agendada (guard do fix 2026-07-16).'));
    RETURN NULL;
  END IF;

  INSERT INTO public.acoes_agendadas (card_id, tipo, executar_em, payload)
  VALUES (
    p_card_id,
    'cobranca_email',
    now() + make_interval(days => p_dias),
    jsonb_strip_nulls(jsonb_build_object(
      'template_id', p_template_id,
      'dias_aguardar', p_dias,
      'agendado_em', now(),
      'origem', p_origem
    ))
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agendar_cobranca_email(uuid, text, int, text) TO service_role;

COMMENT ON FUNCTION public.agendar_cobranca_email(uuid, text, int, text) IS
  'Choke point ÚNICO de agendamento de cobrança automática (fix 2026-07-16). '
  'Flag cobranca_automatica_enabled OFF → no-op. ON → só agenda se '
  'resolver_email_cobranca_cliente devolver e-mail (nunca criar pendência que '
  'falha pra sempre). Nenhum caller pode inserir cobranca_email direto na tabela.';
