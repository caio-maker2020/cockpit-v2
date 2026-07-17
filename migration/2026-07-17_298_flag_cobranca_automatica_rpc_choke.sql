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
--      flag ON → agenda SEMPRE, marcando no payload quando o cliente ainda não
--      tem e-mail resolvível (review 2026-07-17: recusar agendar matava a
--      recuperação quando a Larissa cadastra o contato DEPOIS; a validação na
--      EXECUÇÃO — retry +24h com teto de 5 — cobre o cadastro tardio sem criar
--      pendência eterna, que era o problema real).
--   3. Novo param opcional p_origem (o INSERT direto do executor:relancamento_54
--      foi convertido pro RPC e carregava `origem` no payload).
--   4. REVOKE FROM PUBLIC/anon/authenticated (review 2026-07-17: Postgres dá
--      EXECUTE a PUBLIC por default — sem o REVOKE o GRANT service_role era
--      cosmético e o front poderia chamar o RPC direto).
--   5. marcar_retorno_inconclusivo (mig 041) reescrito pra agendar via o RPC
--      (review 2026-07-17: era a 5ª porta — INSERT direto que bypassava flag
--      e validação, chamada pelo botão "retorno inconclusivo" do front).
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
  v_existente bigint;
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

  -- Flag ON: agenda SEMPRE. Se o cliente ainda não tem e-mail resolvível,
  -- marca no payload e avisa via card_event — a validação na EXECUÇÃO (retry
  -- +24h, teto 5, terminal cancelado+alerta) cobre o cadastro tardio do
  -- contato. Pendência ETERNA (o problema real) já é impossível pela Fase 1.
  -- Dedup (review R2): várias portas podem agendar pro mesmo card (executor
  -- inline/manual, enviar-resposta x2, retorno_inconclusivo). Uma cobrança
  -- pendente por card basta — N pendentes por card era o mesmo mecanismo de
  -- crescimento da fila, só afunilado. Devolve a existente (idempotente).
  SELECT id INTO v_existente
  FROM public.acoes_agendadas
  WHERE card_id = p_card_id AND tipo = 'cobranca_email' AND status = 'pendente'
  ORDER BY executar_em ASC
  LIMIT 1;

  IF v_existente IS NOT NULL THEN
    RAISE LOG 'agendar_cobranca_email: card % já tem cobranca_email pendente (acao %) — dedup, não cria outra',
      p_card_id, v_existente;
    RETURN v_existente;
  END IF;

  SELECT pagador INTO v_pagador FROM public.cards WHERE id = p_card_id;

  v_email := CASE WHEN v_pagador IS NULL THEN NULL
                  ELSE public.resolver_email_cobranca_cliente(v_pagador, 'cobranca') END;

  INSERT INTO public.acoes_agendadas (card_id, tipo, executar_em, payload)
  VALUES (
    p_card_id,
    'cobranca_email',
    now() + make_interval(days => p_dias),
    jsonb_strip_nulls(jsonb_build_object(
      'template_id', p_template_id,
      'dias_aguardar', p_dias,
      'agendado_em', now(),
      'origem', p_origem,
      'sem_contato_no_agendamento', CASE WHEN v_email IS NULL THEN true ELSE NULL END
    ))
  )
  RETURNING id INTO v_id;

  IF v_email IS NULL THEN
    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (p_card_id, 'CobrancaAgendadaSemContato', 'system', 'agendar_cobranca_email',
            jsonb_build_object(
              'acao_id', v_id,
              'documento_cliente', v_pagador,
              'template_id', p_template_id,
              'origem', p_origem,
              'motivo', 'Cliente ainda sem e-mail de cobrança em contatos_cliente. A execução '
                || 'retenta por até 5 tentativas (+24h cada); cadastrar o contato faz a cobrança fluir.'));
  END IF;

  RETURN v_id;
END;
$$;

-- Postgres concede EXECUTE a PUBLIC por default em função nova — sem o REVOKE
-- o GRANT abaixo é cosmético e anon/authenticated chamariam via PostgREST.
REVOKE ALL ON FUNCTION public.agendar_cobranca_email(uuid, text, int, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agendar_cobranca_email(uuid, text, int, text) TO service_role;

COMMENT ON FUNCTION public.agendar_cobranca_email(uuid, text, int, text) IS
  'Choke point ÚNICO de agendamento de cobrança automática (fix 2026-07-16/17). '
  'Flag cobranca_automatica_enabled OFF → no-op. ON → agenda sempre, marcando '
  'sem_contato_no_agendamento quando o e-mail ainda não resolve (execução '
  'retenta com teto — nunca pendência eterna). Nenhum caller pode inserir '
  'cobranca_email direto na tabela (marcar_retorno_inconclusivo incluso, ver abaixo).';

-- 3. marcar_retorno_inconclusivo (definição viva: mig 041) era a 5ª PORTA:
-- INSERT direto de cobranca_email chamado pelo front (botão "retorno
-- inconclusivo"), bypassando flag e validação. Reescrito idêntico, trocando só
-- o INSERT pelo choke point — e o evento/retorno passam a refletir a verdade
-- (com flag OFF nenhuma cobrança é agendada; antes o evento afirmava
-- reagendamento incondicional).
CREATE OR REPLACE FUNCTION public.marcar_retorno_inconclusivo(
  p_card_id uuid,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_card record;
  v_acoes_canc int;
  v_todos_canc int;
  v_nova_acao bigint;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, assigned_operator_id, state, lock_aguardando_validacao
  INTO v_card FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor'
     AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_card.state NOT IN ('AGUARDANDO_AGENTE', 'AGUARDANDO_VALIDACAO_HUMANA') THEN
    RAISE EXCEPTION 'Só funciona em AGUARDANDO_AGENTE ou AGUARDANDO_VALIDACAO_HUMANA (atual: %)', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  WITH canc AS (
    UPDATE public.acoes_agendadas
    SET status = 'cancelado',
        cancelado_motivo = 'retorno marcado como inconclusivo'
    WHERE card_id = p_card_id AND status = 'pendente'
    RETURNING 1
  )
  SELECT count(*) INTO v_acoes_canc FROM canc;

  WITH todos_canc AS (
    UPDATE public.todos
    SET status = 'cancelado',
        rejection_reason = 'retorno inconclusivo — operadora reiniciou ciclo'
    WHERE card_id = p_card_id AND status = 'pendente'
    RETURNING 1
  )
  SELECT count(*) INTO v_todos_canc FROM todos_canc;

  -- Move pra AGUARDANDO_CLIENTE + destrava lock + limpa aviso
  UPDATE public.cards
  SET state = 'AGUARDANDO_CLIENTE',
      lock_aguardando_validacao = false,
      aviso_alteracao_oc = NULL
  WHERE id = p_card_id;

  -- ÚNICA mudança de comportamento vs mig 041: agendamento via choke point
  -- (flag + marcação sem-contato), nunca INSERT direto. NULL = flag OFF.
  v_nova_acao := public.agendar_cobranca_email(
    p_card_id, 'COBRANCA_LEMBRETE', 4, 'retorno_inconclusivo');

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id,
    'RetornoMarcadoComoInconclusivo',
    'operator',
    v_operador_id::text,
    jsonb_build_object(
      'motivo', coalesce(p_motivo, '(sem motivo)'),
      'acoes_canceladas', v_acoes_canc,
      'todos_cancelados', v_todos_canc,
      'cobranca_agendada', v_nova_acao IS NOT NULL,
      'nova_acao_agendada_id', v_nova_acao,
      'reagendado_para', CASE WHEN v_nova_acao IS NOT NULL
                              THEN to_jsonb(now() + interval '4 days')
                              ELSE 'null'::jsonb END,
      'state_anterior', v_card.state,
      'state_novo', 'AGUARDANDO_CLIENTE'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', p_card_id,
    'acoes_canceladas', v_acoes_canc,
    'todos_cancelados', v_todos_canc,
    'cobranca_agendada', v_nova_acao IS NOT NULL,
    'nova_cobranca_em', CASE WHEN v_nova_acao IS NOT NULL
                             THEN to_jsonb(now() + interval '4 days')
                             ELSE 'null'::jsonb END
  );
END;
$$;
