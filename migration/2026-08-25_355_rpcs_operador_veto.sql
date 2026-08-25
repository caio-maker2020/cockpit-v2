-- =============================================================================
-- 2026-08-25_355_rpcs_operador_veto.sql
--
-- ETAPA E do plano de veto (Caio 25/08) — as mãos do OPERADOR na janela:
--   1. cancelar_acao_autonoma(p_agendamento_id, p_respostas) — o botão
--      vermelho. Valida o FORMULÁRIO OBRIGATÓRIO no servidor (popup burlado
--      ≠ dado perdido), cancela o agendamento (só se ainda não claimed —
--      risco 26), grava cancelamentos_acao_autonoma com ciclo + snapshot e
--      o evento AcaoAutonomaCanceladaPeloOperador.
--   2. editar_acao_autonoma(p_agendamento_id, p_campo, p_args_patch,
--      p_novo_hash) — edita SEM cancelar: aplica o patch no proposta_payload
--      do todo, troca o hash do agendamento (exceção deliberada do risco 23),
--      grava edicoes_acao_autonoma (antes/depois) + evento. O hash vem do
--      CLIENTE (mesma função hashDaProposta do processador); se vier errado,
--      o processador devolve pro humano no vencimento — fail-safe, nunca
--      executa às cegas.
--   3. Captura da correção: a PRÓXIMA aprovação humana no card preenche
--      correcao_capturada do cancelamento aberto (o formulário NÃO pergunta
--      "qual era a certa" — a ação seguinte responde).
--
-- Permissão: operador dono do card ou gestor (mesma régua da aprovar_e_executar).
-- SEM begin/commit interno. Idempotente.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Cancelar com formulário
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancelar_acao_autonoma(
  p_agendamento_id bigint,
  p_respostas jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_ag record;
  v_card record;
  v_todo_payload jsonb;
  v_ciclo int;
  v_cancelamento_id uuid;
  v_onde_olhou jsonb;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;
  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_ag FROM public.acoes_agendadas
  WHERE id = p_agendamento_id AND tipo = 'executar_acao_autonoma';
  IF v_ag.id IS NULL THEN
    RAISE EXCEPTION 'Agendamento % não encontrado', p_agendamento_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_ag.status <> 'pendente' THEN
    RAISE EXCEPTION 'Agendamento já em status=% — não dá mais pra vetar por aqui', v_ag.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, assigned_operator_id, pagador INTO v_card
  FROM public.cards WHERE id = v_ag.card_id;
  IF v_operador_papel <> 'gestor' AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra vetar ação do card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Formulário obrigatório validado NO SERVIDOR (dado de treino não se perde):
  IF length(trim(coalesce(p_respostas->>'o_que_leu_errado', ''))) < 5 THEN
    RAISE EXCEPTION 'Formulário: "o que o agente leu errado" é obrigatório'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_onde_olhou := p_respostas->'onde_olhou';
  IF v_onde_olhou IS NULL OR jsonb_typeof(v_onde_olhou) <> 'array'
     OR jsonb_array_length(v_onde_olhou) = 0 THEN
    RAISE EXCEPTION 'Formulário: "onde você olhou" exige ao menos uma fonte'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(p_respostas->>'info_existe_no_cockpit', '')
     NOT IN ('sim_interpretou_errado', 'nao_so_fora') THEN
    RAISE EXCEPTION 'Formulário: responda se a informação existe dentro do Cockpit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(p_respostas->'excecao_cliente') <> 'boolean' THEN
    RAISE EXCEPTION 'Formulário: "é exceção deste cliente?" é obrigatório'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_respostas->>'excecao_cliente')::boolean = true
     AND length(trim(coalesce(p_respostas->>'excecao_qual', ''))) < 3 THEN
    RAISE EXCEPTION 'Formulário: descreva qual é a exceção do cliente'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Corrida cancelar × executar (risco 26): só mata quem ainda está pendente.
  UPDATE public.acoes_agendadas
  SET status = 'cancelado',
      cancelado_motivo = 'vetado pelo operador (formulário preenchido)',
      processed_at = now()
  WHERE id = p_agendamento_id AND status = 'pendente';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agendamento entrou em execução durante o veto — confira a aba de executadas'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT proposta_payload INTO v_todo_payload
  FROM public.todos WHERE id = (v_ag.payload->>'todo_id')::uuid;

  -- ciclo atual do card (régua 25/08): nº de eventos de abertura até agora
  SELECT greatest(1, count(*))::int INTO v_ciclo
  FROM public.card_events
  WHERE card_id = v_ag.card_id
    AND event_type IN ('BastaoCardImportado','ExtravioImportado',
                       'BastaoReabriuNFFonteRelacionamento','CardReaberto',
                       'CardReabertoPorRespostaCliente');

  INSERT INTO public.cancelamentos_acao_autonoma
    (card_id, agendamento_id, agent_name, acao_key, ciclo, operador_id,
     respostas, snapshot_proposta)
  VALUES (
    v_ag.card_id, p_agendamento_id,
    coalesce(v_ag.payload->>'agent_name', 'desconhecido'),
    coalesce(v_ag.payload->>'acao_key', 'desconhecida'),
    v_ciclo, v_operador_id, p_respostas,
    coalesce(v_todo_payload, v_ag.payload)
  )
  RETURNING id INTO v_cancelamento_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_ag.card_id, 'AcaoAutonomaCanceladaPeloOperador', 'operator', v_operador_id::text,
    jsonb_build_object(
      'agendamento_id', p_agendamento_id,
      'cancelamento_id', v_cancelamento_id,
      'acao_key', v_ag.payload->>'acao_key',
      'ciclo', v_ciclo
    )
  );

  RETURN jsonb_build_object('ok', true, 'cancelamento_id', v_cancelamento_id, 'ciclo', v_ciclo);
END;
$function$;

REVOKE ALL ON FUNCTION public.cancelar_acao_autonoma(bigint, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancelar_acao_autonoma(bigint, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.cancelar_acao_autonoma IS
  'Botão vermelho da janela de veto (plano 25/08): valida o formulário no '
  'servidor, cancela SÓ se ainda pendente (corrida risco 26), grava o '
  'cancelamento com ciclo+snapshot e o evento. A correção vem depois, pela '
  'captura automática da próxima aprovação humana.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Editar sem cancelar (a contagem continua)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.editar_acao_autonoma(
  p_agendamento_id bigint,
  p_campo text,
  p_args_patch jsonb,
  p_novo_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_ag record;
  v_todo record;
  v_payload_novo jsonb;
  v_hash_antes text;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;
  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_args_patch IS NULL OR jsonb_typeof(p_args_patch) <> 'object'
     OR p_novo_hash IS NULL OR length(p_novo_hash) < 8 THEN
    RAISE EXCEPTION 'Edição exige patch (objeto) e o novo hash da proposta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_ag FROM public.acoes_agendadas
  WHERE id = p_agendamento_id AND tipo = 'executar_acao_autonoma';
  IF v_ag.id IS NULL OR v_ag.status <> 'pendente' THEN
    RAISE EXCEPTION 'Agendamento % não está mais editável (status=%)',
      p_agendamento_id, coalesce(v_ag.status, 'inexistente')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_operador_papel <> 'gestor' THEN
    PERFORM 1 FROM public.cards c
    WHERE c.id = v_ag.card_id AND c.assigned_operator_id = v_operador_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sem permissão pra editar ação do card %', v_ag.card_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT id, status, proposta_payload INTO v_todo
  FROM public.todos WHERE id = (v_ag.payload->>'todo_id')::uuid;
  IF v_todo.id IS NULL OR v_todo.status <> 'pendente' THEN
    RAISE EXCEPTION 'Todo da ação não está mais pendente' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_hash_antes := v_ag.payload->>'hash_proposta';

  -- merge raso em args (mesma semântica da mig 226). NÃO carimbar meta aqui:
  -- o hash do cliente é calculado sobre EXATAMENTE este payload final e o
  -- processador recompara no vencimento — qualquer byte extra devolveria a
  -- ação pro humano. A auditoria da edição vive em edicoes_acao_autonoma +
  -- card_event (abaixo), não no payload.
  v_payload_novo := jsonb_set(
    v_todo.proposta_payload,
    '{args}',
    COALESCE(v_todo.proposta_payload->'args', '{}'::jsonb) || p_args_patch,
    true
  );

  UPDATE public.todos SET proposta_payload = v_payload_novo WHERE id = v_todo.id;

  -- exceção deliberada do risco 23: a edição LEGÍTIMA atualiza o hash
  UPDATE public.acoes_agendadas
  SET payload = jsonb_set(payload, '{hash_proposta}', to_jsonb(p_novo_hash), true)
  WHERE id = p_agendamento_id AND status = 'pendente';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agendamento entrou em execução durante a edição'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.edicoes_acao_autonoma
    (card_id, agendamento_id, agent_name, acao_key, operador_id, campo,
     valor_antes, valor_depois, hash_antes, hash_depois)
  VALUES (
    v_ag.card_id, p_agendamento_id,
    coalesce(v_ag.payload->>'agent_name', 'desconhecido'),
    coalesce(v_ag.payload->>'acao_key', 'desconhecida'),
    v_operador_id, p_campo,
    v_todo.proposta_payload->'args', v_payload_novo->'args',
    v_hash_antes, p_novo_hash
  );

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_ag.card_id, 'AcaoAutonomaEditadaPeloOperador', 'operator', v_operador_id::text,
    jsonb_build_object(
      'agendamento_id', p_agendamento_id,
      'campo', p_campo,
      'hash_antes', v_hash_antes,
      'hash_depois', p_novo_hash
    )
  );

  RETURN jsonb_build_object('ok', true, 'hash_depois', p_novo_hash);
END;
$function$;

REVOKE ALL ON FUNCTION public.editar_acao_autonoma(bigint, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.editar_acao_autonoma(bigint, text, jsonb, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.editar_acao_autonoma IS
  'Edição dentro da janela de veto SEM cancelar (plano 25/08): patch nos args '
  'do todo + novo hash no agendamento (exceção deliberada do risco 23) + '
  'antes/depois em edicoes_acao_autonoma. Hash calculado no cliente com a '
  'MESMA hashDaProposta do processador; hash errado → devolve no vencimento.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Captura da correção: próxima aprovação humana preenche o cancelamento
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_captura_correcao_veto()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.event_type <> 'AprovacaoOperador' THEN
    RETURN NEW;
  END IF;
  UPDATE public.cancelamentos_acao_autonoma c
  SET correcao_capturada = jsonb_build_object(
        'event_id', NEW.id,
        'aprovado_em', NEW.created_at,
        'todo_id', NEW.payload->'todo_id',
        'acao_key', NEW.payload->'proposta_payload'->>'acao_key',
        'tool', NEW.payload->'proposta_payload'->>'tool',
        'codigo_ssw', NEW.payload->'proposta_payload'->'args'->'codigo_ssw'
      )
  WHERE c.card_id = NEW.card_id
    AND c.correcao_capturada IS NULL
    AND c.created_at > now() - interval '7 days';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_captura_correcao_veto ON public.card_events;
CREATE TRIGGER trg_captura_correcao_veto
  AFTER INSERT ON public.card_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_captura_correcao_veto();

COMMENT ON FUNCTION public.fn_captura_correcao_veto() IS
  'Plano 25/08: a "sugestão certa" não é perguntada no formulário — é a '
  'PRÓXIMA ação humana no card. Aprovação após um cancelamento aberto (7d) '
  'vira correcao_capturada do cancelamento.';
