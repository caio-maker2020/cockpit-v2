-- ============================================================================
-- 2026-08-10_324 — TRAVA MODO VISUALIZAÇÃO (João Penha + Isadora Baldoni).
--
-- Decisões do Caio (10/08): os dois veem TUDO (RLS gestor intacta) mas não
-- executam ações de card nem cadastros. Aprendizado LIVRE pros dois (chat +
-- fila de melhorias). Caio (gestor) segue com pode_executar=true.
--
-- Camadas: coluna + helpers → guard nos 17 RPCs SECURITY DEFINER → policies
-- RESTRICTIVE de escrita (writes diretos do front). service_role nunca trava
-- (auth.uid() null → coalesce true) — crons/agentes intactos.
-- Gerado por scripts/gerar_mig_trava_visualizacao.py a partir do banco.
-- ============================================================================

-- TRANSAÇÕES CURTAS, não uma só: transação única deadlockava com os crons
-- (segurava operadores esperando cards ↔ cron segurando cards lendo operadores).
-- Cada bloco é idempotente — se um falhar por lock, re-rodar o arquivo cura.

-- Bloco 1: coluna + flags + helpers (locks só em operadores) -----------------
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.operadores
  ADD COLUMN IF NOT EXISTS pode_executar boolean NOT NULL DEFAULT true;

UPDATE public.operadores SET pode_executar = false
WHERE lower(email) IN ('joao.penha@salexpress.com.br',
                       'isadora.baldoni@salexpress.com.br');

CREATE OR REPLACE FUNCTION public.current_operador_pode_executar()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT pode_executar FROM public.operadores WHERE user_id = auth.uid() LIMIT 1),
    true);  -- sem operador (service_role/cron) → nunca trava
$$;

CREATE OR REPLACE FUNCTION public.assert_pode_executar()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_operador_pode_executar() THEN
    RAISE EXCEPTION 'MODO_VISUALIZACAO: seu usuário é somente visualização — ações bloqueadas'
      USING ERRCODE = 'P0403';
  END IF;
END $$;

COMMIT;

-- Bloco 2: guard nos 17 RPCs de mutação (locks só em pg_proc) ----------------
BEGIN;
SET LOCAL lock_timeout = '5s';
-- ── aprovar_e_executar: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.aprovar_e_executar(p_todo_id uuid, p_extras jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pgmq'
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_todo record;
  v_card record;
  v_msg_id bigint;
  v_outros_cancelados int;
  v_proposta_payload jsonb;
  v_tool text;
  v_qtd_tratativas int;
  v_skip_oc boolean;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, card_id, action_id, proposta_payload, status
  INTO v_todo FROM public.todos WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_todo.status <> 'pendente' THEN
    RAISE EXCEPTION 'Todo % já em status=%', p_todo_id, v_todo.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, assigned_operator_id, state, nf, ctrc, sem_chave_cte, tratativa_email_escolhida
  INTO v_card
  FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  IF v_operador_papel <> 'gestor' AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra aprovar todo do card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_tool := v_todo.proposta_payload->>'tool';
  IF v_card.sem_chave_cte = true AND v_tool IN ('lancar_ocorrencia', 'lancar_oc_e_enviar_email') THEN
    RAISE EXCEPTION 'Card NF % sem chave fiscal cadastrada (sem_chave_cte=true). RPA OPC 455 ainda não importou. Aguarde alguns minutos ou cadastre chave manual.', v_card.nf
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Caio 2026-06-17 (mig 212): se a ação envia e-mail e o card tem MAIS DE UMA
  -- tratativa de e-mail ATIVA (threads Gmail distintas cuja última msg é inbound
  -- de cliente externo = ambas aguardando nossa resposta — feature de junção por
  -- NF/assunto), a operadora PRECISA escolher qual responder antes de aprovar
  -- (senão a resposta pode sair na thread/pro destinatário errado). Threads
  -- sequenciais antigas já respondidas NÃO contam (não travam o operador à toa).
  -- Só bloqueia ações de e-mail; lançamento de oc puro no SSW não depende de thread.
  IF v_tool ILIKE '%email%' AND v_card.tratativa_email_escolhida IS NULL THEN
    SELECT count(*) INTO v_qtd_tratativas FROM (
      SELECT 1
      FROM (
        SELECT NULLIF(mi.raw_payload->>'gmail_thread_id','') AS thr,
               'in'::text AS dir, mi.remetente AS addr, mi.recebido_em AS ts
          FROM public.messages_inbox mi
         WHERE mi.card_id = v_todo.card_id AND mi.canal = 'email'
        UNION ALL
        SELECT NULLIF(eo.gmail_thread_id,''), 'out'::text, eo.to_email, eo.sent_at
          FROM public.cards_emails_outbound eo
         WHERE eo.card_id = v_todo.card_id
      ) m
      WHERE m.thr IS NOT NULL
      GROUP BY m.thr
      HAVING (ARRAY_AGG(m.dir  ORDER BY m.ts DESC))[1] = 'in'
         AND (ARRAY_AGG(m.addr ORDER BY m.ts DESC))[1] NOT ILIKE '%@salexpress.com.br'
    ) ativas;

    IF v_qtd_tratativas > 1 THEN
      RAISE EXCEPTION 'Card NF % tem mais de uma tratativa de e-mail aguardando resposta. Selecione qual tratativa responder antes de aprovar a ação de e-mail.', v_card.nf
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  v_proposta_payload := v_todo.proposta_payload;
  IF p_extras IS NOT NULL AND jsonb_typeof(p_extras) = 'object' THEN
    -- Caio 2026-06-22 (mig 226): MERGE, não REPLACE. Preserva extras setados na
    -- criação da proposta (ex.: skip_oc, enviar_email, texto_descricao) e deixa
    -- o front vencer apenas nos campos que ele realmente manda. REPLACE apagava
    -- skip_oc=true e quebrava a ação "só e-mail" da aba Extravios.
    v_proposta_payload := jsonb_set(
      v_proposta_payload,
      '{args,extras}',
      COALESCE(v_todo.proposta_payload->'args'->'extras', '{}'::jsonb) || p_extras,
      true
    );
  END IF;

  -- Caio 2026-07-20 (mig 299): skip_oc = ação "só notificar cliente por e-mail,
  -- SEM lançar ocorrência" (email_sem_oc, aba Extravios). Lido do payload JÁ
  -- mergeado com p_extras (o front pode reforçar o flag). Só o email_sem_oc produz
  -- skip_oc — ver extravio-enrichment.ts.
  v_skip_oc := COALESCE((v_proposta_payload #>> '{args,extras,skip_oc}')::boolean, false);

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id, 'AprovacaoOperador', 'operator', v_operador_id::text,
    jsonb_build_object(
      'todo_id', p_todo_id,
      'action_id', v_todo.action_id,
      'proposta_payload', v_proposta_payload,
      'extras', p_extras
    )
  );

  UPDATE public.todos
  SET status = 'aprovado',
      approved_by = v_operador_id,
      approved_at = now(),
      proposta_payload = v_proposta_payload
  WHERE id = p_todo_id;

  -- Caio 2026-07-20 (mig 299): NÃO cancela as irmãs quando skip_oc=true. O
  -- email_sem_oc só notifica o cliente e mantém o card em EXTRAVIO_MONITORADO — as
  -- opções de lançar (49/54/55) TÊM que continuar disponíveis pra quando o cliente
  -- responder. O executor já documenta "zero efeito nas demais propostas" (skip_oc);
  -- o cancelamento cego aqui quebrava isso. Cards-âncora: NF 335713 / 232346.
  v_outros_cancelados := 0;
  IF NOT v_skip_oc THEN
    WITH outros_canc AS (
      UPDATE public.todos
      SET status = 'cancelado',
          rejection_reason = 'Auto-cancelado: outra opção foi aprovada no mesmo card'
      WHERE card_id = v_todo.card_id
        AND id <> p_todo_id
        AND status = 'pendente'
      RETURNING id
    )
    SELECT count(*) INTO v_outros_cancelados FROM outros_canc;

    IF v_outros_cancelados > 0 THEN
      INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
      VALUES (
        v_todo.card_id, 'TodosConcorrentesCancelados', 'system', 'aprovar_e_executar',
        jsonb_build_object(
          'aprovado', p_todo_id,
          'cancelados', v_outros_cancelados,
          'motivo', 'Operadora escolheu uma das opções; demais ficaram obsoletas'
        )
      );
    END IF;
  END IF;

  -- Caio 2026-05-11 (mig 083): NÃO limpa ia_sugestao_oc_resposta nem
  -- cliente_respondeu_em aqui. Limpeza correta acontece no executor ao
  -- setar state=ACAO_EXECUTADA (sucesso SSW confirmado). Em caso de falha,
  -- reverter_acao_falhou volta pra AVH + lock=true PRESERVANDO contexto da
  -- resposta — Pass A do sync-bastao respeita a exceção clienteJaRespondeu
  -- e não força AGUARDANDO_CLIENTE. Larissa vê card de volta na aba CLIENTE
  -- RESPONDEU com sugestão IA preservada pra tentar outra opção.
  UPDATE public.cards
  SET aprovacao_modo = 'humana',
      lock_aguardando_validacao = false,
      aviso_alteracao_oc = NULL,
      state = 'EXECUTANDO_ACAO'
  WHERE id = v_todo.card_id;

  v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
    'todo_id', p_todo_id, 'card_id', v_todo.card_id,
    'action_id', v_todo.action_id, 'proposta_payload', v_proposta_payload,
    'aprovado_por', v_operador_id, 'card_nf', v_card.nf, 'card_ctrc', v_card.ctrc
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'todo_id', p_todo_id,
    'card_id', v_todo.card_id,
    'pgmq_msg_id', v_msg_id,
    'outros_cancelados', v_outros_cancelados,
    'extras_aplicados', p_extras IS NOT NULL
  );
END;
$function$;

-- ── escolher_tratativa_email: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.escolher_tratativa_email(p_card_id uuid, p_thread_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id    uuid;
  v_operador_papel text;
  v_card           record;
  v_thread_existe  boolean;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, assigned_operator_id INTO v_card
  FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor'
     AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra escolher tratativa do card %', p_card_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- valida que a thread realmente pertence ao card (evita gravar lixo)
  IF p_thread_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.messages_inbox mi
       WHERE mi.card_id = p_card_id
         AND mi.raw_payload->>'gmail_thread_id' = p_thread_id
      UNION ALL
      SELECT 1 FROM public.cards_emails_outbound eo
       WHERE eo.card_id = p_card_id
         AND eo.gmail_thread_id = p_thread_id
    ) INTO v_thread_existe;

    IF NOT v_thread_existe THEN
      RAISE EXCEPTION 'Thread % não pertence ao card %', p_thread_id, p_card_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  UPDATE public.cards
  SET tratativa_email_escolhida = p_thread_id,
      updated_at = now()
  WHERE id = p_card_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'TratativaEmailEscolhida', 'operator', v_operador_id::text,
    jsonb_build_object('gmail_thread_id', p_thread_id)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', p_card_id,
    'tratativa_email_escolhida', p_thread_id
  );
END;
$function$;

-- ── ignorar_pendencias_resposta_cliente: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.ignorar_pendencias_resposta_cliente(p_card_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_card record;
  v_sugestao_anterior jsonb;
  v_deve_manter_avh boolean;
  v_state_novo text;
  v_lock_novo boolean;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, assigned_operator_id, state, lock_aguardando_validacao,
         cliente_respondeu_em, ia_sugestao_oc_resposta,
         cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia
  INTO v_card FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor'
     AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra ignorar pendências do card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_card.state <> 'AGUARDANDO_VALIDACAO_HUMANA' THEN
    RAISE EXCEPTION 'Só funciona quando card está em CLIENTE RESPONDEU (state atual: %)', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_card.cliente_respondeu_em IS NULL THEN
    RAISE EXCEPTION 'Card % não tem resposta de cliente pra ignorar', v_card.id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock aqui é lock de VALIDAÇÃO HUMANA (vinculador setou quando cliente
  -- respondeu), não de execução. O lock de execução real está no state.
  IF v_card.state IN ('EXECUTANDO_ACAO', 'EM_EXECUCAO_AUTOMATICA', 'ACAO_EXECUTADA') THEN
    RAISE EXCEPTION 'Card está em execução de ação (state=%). Aguarde finalizar.', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_sugestao_anterior := v_card.ia_sugestao_oc_resposta;

  -- GUARD INV-019 (fato verificado — bug NF 1119469): predicado IDÊNTICO ao
  -- /verify-cockpit. O card só PODE deixar de ir pra AGUARDANDO_CLIENTE quando é
  -- oc de RELACIONAMENTO ≠{54,59} E não está em lag pós-lançamento de cliente.
  -- Caio 2026-07-13 (separação 54/59): a exceção de lag reconhece lançamento de
  -- 54 OU 59 (ambas põem o card em AGUARDANDO_CLIENTE). Sem o 59, um card cujo
  -- Cockpit lançou 59 e cujo Bastão ainda laga na oc anterior ficaria preso em AVH.
  v_deve_manter_avh := (
    v_card.cod_ultima_ocorrencia IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52)
    AND NOT EXISTS (
      SELECT 1 FROM public.acoes_executadas_ssw a
      WHERE a.card_id = p_card_id
        AND a.codigo_oc IN (54,59)
        AND a.sucesso
        AND (a.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
            >= v_card.bastao_data_ultima_ocorrencia
    )
  );

  IF v_deve_manter_avh THEN
    -- oc de relacionamento ≠{54,59}: NÃO pode ir pra AGUARDANDO_CLIENTE (INV-019).
    -- Fica em AGUARDANDO VOCÊ (AVH+lock). Limpa os sinais de "cliente respondeu"
    -- pra sair da aba CLIENTE RESPONDEU, mas o operador ainda precisa LANÇAR a oc.
    v_state_novo := 'AGUARDANDO_VALIDACAO_HUMANA';
    v_lock_novo := true;

    UPDATE public.cards
    SET state = 'AGUARDANDO_VALIDACAO_HUMANA',
        lock_aguardando_validacao = true,
        cliente_respondeu_em = NULL,
        ia_sugestao_oc_resposta = NULL
    WHERE id = p_card_id;

    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (
      p_card_id,
      'PendenciasRespostaIgnoradasMantidoEmAguardandoVoce',
      'operator',
      v_operador_id::text,
      jsonb_build_object(
        'motivo', coalesce(p_motivo, '(sem motivo informado)'),
        'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia,
        'state_anterior', 'AGUARDANDO_VALIDACAO_HUMANA',
        'state_novo', 'AGUARDANDO_VALIDACAO_HUMANA',
        'lock_anterior', v_card.lock_aguardando_validacao,
        'lock_novo', true,
        'cliente_respondeu_em_zerado', v_card.cliente_respondeu_em,
        'ia_sugestao_anterior', v_sugestao_anterior,
        'regra', 'INV-019',
        'observacao', 'oc de relacionamento ≠{54,59}: card não pode ir pra AGUARDANDO_CLIENTE. Fica em AGUARDANDO VOCÊ (AVH+lock) até a operadora lançar a ocorrência.'
      )
    );
  ELSE
    -- oc∈{54,59}, lag pós-cliente, ou fora de escopo → AGUARDANDO_CLIENTE
    -- (comportamento atual preservado). Card volta limpo; próxima resposta re-aciona.
    v_state_novo := 'AGUARDANDO_CLIENTE';
    v_lock_novo := false;

    UPDATE public.cards
    SET state = 'AGUARDANDO_CLIENTE',
        lock_aguardando_validacao = false,
        cliente_respondeu_em = NULL,
        ia_sugestao_oc_resposta = NULL
    WHERE id = p_card_id;

    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (
      p_card_id,
      'PendenciasRespostaIgnoradas',
      'operator',
      v_operador_id::text,
      jsonb_build_object(
        'motivo', coalesce(p_motivo, '(sem motivo informado)'),
        'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia,
        'state_anterior', 'AGUARDANDO_VALIDACAO_HUMANA',
        'state_novo', 'AGUARDANDO_CLIENTE',
        'lock_anterior', v_card.lock_aguardando_validacao,
        'cliente_respondeu_em_zerado', v_card.cliente_respondeu_em,
        'ia_sugestao_anterior', v_sugestao_anterior
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', p_card_id,
    'state_novo', v_state_novo,
    'lock_novo', v_lock_novo,
    -- front usa isso pra avisar a operadora que o card NÃO saiu de AGUARDANDO
    -- VOCÊ (oc de relacionamento ≠{54,59} — invariante oc de cliente ⟺ AGUARDANDO_CLIENTE).
    'permaneceu_em_aguardando_voce', v_deve_manter_avh,
    'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia
  );
END;
$function$;

-- ── adotar_thread_preexistente: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.adotar_thread_preexistente(p_card_id uuid, p_gmail_thread_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pgmq'
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_card uuid;
  v_existe boolean;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  IF p_gmail_thread_id IS NULL OR length(trim(p_gmail_thread_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'gmail_thread_id obrigatório');
  END IF;

  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  SELECT assigned_operator_id INTO v_operador_card FROM public.cards WHERE id = p_card_id;

  SELECT EXISTS (
    SELECT 1
    FROM public.cards c,
         jsonb_array_elements(COALESCE(c.email_preexistente_sugerido->'candidatos', '[]'::jsonb)) cand
    WHERE c.id = p_card_id
      AND cand->>'gmail_thread_id' = p_gmail_thread_id
  ) INTO v_existe;
  IF NOT v_existe THEN
    RETURN jsonb_build_object('ok', false, 'error', 'thread não está entre os candidatos do card');
  END IF;

  IF v_operador_id IS NOT NULL AND v_operador_card IS NOT NULL AND v_operador_card <> v_operador_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'card não pertence ao operador');
  END IF;

  UPDATE public.cards
  SET email_preexistente_sugerido = email_preexistente_sugerido
        || jsonb_build_object('decisao', 'seguir', 'decidido_em', now(), 'thread_adotada', p_gmail_thread_id)
  WHERE id = p_card_id
    AND email_preexistente_sugerido IS NOT NULL;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'ThreadPreexistenteAdotada', 'operator',
          COALESCE(v_operador_id::text, 'desconhecido'),
          jsonb_build_object('gmail_thread_id', p_gmail_thread_id));

  UPDATE public.email_preexistente_scan
  SET resultado = 'adotado', decidido_em = now()
  WHERE card_id = p_card_id;

  PERFORM pgmq.send('importar_thread_adotada', jsonb_build_object(
    'card_id', p_card_id,
    'gmail_thread_id', p_gmail_thread_id,
    'operador_id', COALESCE(v_operador_card, v_operador_id)
  ));

  RETURN jsonb_build_object('ok', true, 'decisao', 'seguir', 'importacao', 'enfileirada');
END;
$function$;

-- ── descartar_email_preexistente: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.descartar_email_preexistente(p_card_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
  v_thr text;
  v_auto boolean;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  SELECT email_preexistente_sugerido->>'thread_principal',
         (email_preexistente_sugerido->>'auto')::boolean
    INTO v_thr, v_auto
    FROM public.cards WHERE id = p_card_id;

  IF COALESCE(v_auto, false) THEN
    -- Reverte a adoção automática (só o que a feature importou).
    DELETE FROM public.email_anexos WHERE message_inbox_id IN (
      SELECT id FROM public.messages_inbox
      WHERE card_id = p_card_id AND raw_payload->>'origem' = 'scan-email-pre-card');
    DELETE FROM public.messages_inbox
      WHERE card_id = p_card_id AND raw_payload->>'origem' = 'scan-email-pre-card';
    IF v_thr IS NOT NULL THEN
      DELETE FROM public.cards_emails_outbound
        WHERE card_id = p_card_id AND gmail_thread_id = v_thr;
    END IF;

    UPDATE public.cards c SET
      email_preexistente_sugerido = NULL,
      ia_sugestao_oc_resposta = NULL,
      tratativa_email_escolhida = CASE WHEN c.tratativa_email_escolhida = v_thr THEN NULL ELSE c.tratativa_email_escolhida END,
      cliente_respondeu_em = CASE
        WHEN NOT EXISTS (SELECT 1 FROM public.messages_inbox m WHERE m.card_id = c.id) THEN NULL
        ELSE c.cliente_respondeu_em END,
      -- Caio 2026-07-13 (separação 54/59): {54,59} são as ocs de cliente que residem
      -- em AGUARDANDO_CLIENTE — a reversão da adoção destrava/devolve as DUAS.
      lock_aguardando_validacao = CASE
        WHEN c.state = 'AGUARDANDO_VALIDACAO_HUMANA' AND c.cod_ultima_ocorrencia IN (54,59)
             AND NOT EXISTS (SELECT 1 FROM public.messages_inbox m WHERE m.card_id = c.id) THEN false
        ELSE c.lock_aguardando_validacao END,
      state = CASE
        WHEN c.state = 'AGUARDANDO_VALIDACAO_HUMANA' AND c.cod_ultima_ocorrencia IN (54,59)
             AND NOT EXISTS (SELECT 1 FROM public.messages_inbox m WHERE m.card_id = c.id) THEN 'AGUARDANDO_CLIENTE'
        ELSE c.state END
    WHERE c.id = p_card_id;
  ELSE
    -- Sugestão não-adotada (banner pendente): só marca decidido.
    UPDATE public.cards
    SET email_preexistente_sugerido = email_preexistente_sugerido
          || jsonb_build_object('decisao', 'novo', 'decidido_em', now())
    WHERE id = p_card_id AND email_preexistente_sugerido IS NOT NULL;
  END IF;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'EmailPreexistenteDescartado', 'operator',
          COALESCE(v_operador_id::text, 'desconhecido'),
          jsonb_build_object('revertido', COALESCE(v_auto, false)));

  UPDATE public.email_preexistente_scan
  SET resultado = 'descartado', decidido_em = now() WHERE card_id = p_card_id;

  RETURN jsonb_build_object('ok', true, 'revertido', COALESCE(v_auto, false));
END;
$function$;

-- ── extravios_atualizar_status: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.extravios_atualizar_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
  v_ultimo_bastao timestamptz;
  v_ultimo_clique timestamptz;
  v_lock_bastao timestamptz;
  v_lock_operador timestamptz;
  v_liberado_em timestamptz;
  v_motivo text;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  IF v_operador_id IS NULL THEN
    RETURN jsonb_build_object('bloqueado', false, 'sem_operador', true);
  END IF;

  SELECT ultimo_sync_extravios INTO v_ultimo_bastao FROM public.sync_status_global WHERE id = 1;
  SELECT ultimo_clique_em INTO v_ultimo_clique
    FROM public.extravios_atualizar_lock WHERE operador_id = v_operador_id;

  v_lock_bastao   := v_ultimo_bastao  + interval '20 minutes';
  v_lock_operador := v_ultimo_clique  + interval '10 minutes';
  v_liberado_em   := GREATEST(COALESCE(v_lock_bastao, to_timestamp(0)),
                              COALESCE(v_lock_operador, to_timestamp(0)));

  IF v_liberado_em = v_lock_bastao THEN v_motivo := 'sync_bastao';
  ELSIF v_liberado_em = v_lock_operador THEN v_motivo := 'clique_operador';
  ELSE v_motivo := NULL; END IF;

  RETURN jsonb_build_object(
    'bloqueado', v_liberado_em > now(),
    'liberado_em', v_liberado_em,
    'segundos_restantes', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_liberado_em - now()))))::int,
    'motivo', v_motivo
  );
END;
$function$;

-- ── lancar_oc_emergencial_acao_executada: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.lancar_oc_emergencial_acao_executada(p_card_id uuid, p_codigo_ssw integer, p_texto_descricao text DEFAULT NULL::text, p_anexo_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pgmq'
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_card record;
  v_oc record;
  v_chave_cte text;
  v_cnpj_remetente text;
  v_action_id uuid := gen_random_uuid();
  v_todo_id uuid := gen_random_uuid();
  v_proposta_payload jsonb;
  v_msg_id bigint;
  v_extras jsonb;
  v_anexo record;
  v_propostas_pendentes int;
  v_state_label text;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  -- 1. Auth
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2. Card check
  SELECT id, assigned_operator_id, state, nf, ctrc, sem_chave_cte, agent_state,
         cod_ultima_ocorrencia
  INTO v_card FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id;
  END IF;

  IF v_operador_papel <> 'gestor' AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra agir no card %', p_card_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Gate v4: 3 cenários permitidos. v_state_label vira label legível pra audit.
  IF v_card.state = 'ACAO_EXECUTADA' THEN
    v_state_label := 'ACAO_EXECUTADA';
  ELSIF v_card.state = 'AGUARDANDO_AGENTE' THEN
    SELECT count(*) INTO v_propostas_pendentes
    FROM public.todos
    WHERE card_id = p_card_id AND status IN ('pendente', 'aprovado');

    IF v_propostas_pendentes > 0 THEN
      RAISE EXCEPTION 'Card % em AGUARDANDO_AGENTE tem % proposta(s) ativa(s) — use as propostas existentes.', p_card_id, v_propostas_pendentes
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_state_label := 'AGUARDANDO_AGENTE_sem_propostas';
  ELSIF v_card.state = 'AGUARDANDO_VALIDACAO_HUMANA' AND v_card.cod_ultima_ocorrencia = 20 THEN
    -- Caio 2026-05-11: caso especial "RECUSAR FLOW SUGERIDO" pra oc=20 (extravio
    -- localizado lançado indevidamente pela operação). Larissa lança oc qualquer
    -- pra reverter sem esperar correção upstream.
    v_state_label := 'AGUARDANDO_VALIDACAO_HUMANA_oc20_recusar_flow';
  ELSE
    RAISE EXCEPTION 'RPC emergencial só roda em ACAO_EXECUTADA, AGUARDANDO_AGENTE (sem propostas) ou AGUARDANDO_VALIDACAO_HUMANA com oc=20. Card % está em state=% com oc=%',
      p_card_id, v_card.state, v_card.cod_ultima_ocorrencia
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Caio 2026-06-18 (mig 220): gate `sem_chave_cte` REMOVIDO. Portal 101 não
  -- precisa de chave fiscal — usa card.ctrc + buscarNFInterno. Bloquear aqui
  -- impedia lançamento manual em cards perfeitamente lançáveis.

  -- 3. Validar oc destino contra o dicionário oficial (mig 204). Substitui o
  --    SELECT em ocorrencias_dexpara (DROPADA na mig 195).
  SELECT codigo, descricao INTO v_oc
  FROM public.ocorrencias_dicionario
  WHERE codigo = p_codigo_ssw;

  IF v_oc.codigo IS NULL THEN
    RAISE EXCEPTION 'Código SSW % não consta no dicionário de ocorrências (ocorrencias_dicionario)', p_codigo_ssw
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 4. Extrai chave_cte + cnpj_remetente do agent_state. Caio 2026-06-18 (mig
  --    220): chave_cte pode ser NULL — portal não exige. Mantida no payload só
  --    por compatibilidade/informativo; o executor ignora pro portal.
  v_chave_cte := v_card.agent_state->>'chave_cte';
  v_cnpj_remetente := COALESCE(
    v_card.agent_state->>'cnpj_remetente',
    v_card.agent_state->>'cnpj_pagador'
  );

  -- 5. Anexo opcional
  IF p_anexo_id IS NOT NULL THEN
    SELECT id, mime_type, filename, deletado_em INTO v_anexo
    FROM public.email_anexos WHERE id = p_anexo_id;

    IF v_anexo.id IS NULL THEN
      RAISE EXCEPTION 'Anexo % não encontrado em email_anexos', p_anexo_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_anexo.deletado_em IS NOT NULL THEN
      RAISE EXCEPTION 'Anexo % já foi deletado/enviado', p_anexo_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_anexo.mime_type NOT IN ('image/jpeg', 'image/jpg', 'image/pjpeg', 'application/pdf') THEN
      RAISE EXCEPTION 'Anexo % com mime_type % não suportado pelo SSW (apenas JPEG/PDF)',
        p_anexo_id, v_anexo.mime_type
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  -- 6. Extras
  v_extras := '{}'::jsonb;
  IF p_texto_descricao IS NOT NULL AND length(trim(p_texto_descricao)) > 0 THEN
    v_extras := v_extras || jsonb_build_object('texto_descricao', p_texto_descricao);
  END IF;
  IF p_anexo_id IS NOT NULL THEN
    v_extras := v_extras || jsonb_build_object('anexo_id', p_anexo_id::text);
  END IF;

  -- 7. proposta_payload
  v_proposta_payload := jsonb_build_object(
    'tool', 'lancar_ocorrencia',
    'args', jsonb_build_object(
      'nf', v_card.nf,
      'codigo_ssw', p_codigo_ssw,
      'chave_cte', v_chave_cte,
      'cnpj_remetente', v_cnpj_remetente,
      'descricao', v_oc.descricao,
      'extras', v_extras
    ),
    'meta', jsonb_build_object(
      'modo', 'emergencial',
      'origem', 'lancar_oc_emergencial_acao_executada',
      'state_origem', v_card.state,
      'state_label', v_state_label,
      'oc_anterior_card', v_card.cod_ultima_ocorrencia,
      'tem_anexo', (p_anexo_id IS NOT NULL)
    ),
    'rationale', 'Caio 2026-05-11: lançamento emergencial em ' || v_state_label
      || ' — oc=' || p_codigo_ssw::text
      || CASE WHEN p_anexo_id IS NOT NULL THEN ' com anexo' ELSE '' END
      || '.'
  );

  -- 8. Cria todo aprovado
  INSERT INTO public.todos (
    id, card_id, action_id, descricao, proposta_payload,
    status, approved_by, approved_at
  ) VALUES (
    v_todo_id, p_card_id, v_action_id,
    'Lançamento emergencial oc=' || p_codigo_ssw || ' (' || v_oc.descricao || ')'
      || CASE WHEN p_anexo_id IS NOT NULL THEN ' [com anexo]' ELSE '' END,
    v_proposta_payload,
    'aprovado', v_operador_id, now()
  );

  -- 9. Audit
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'AprovacaoEmergencialOperador', 'operator', v_operador_id::text,
    jsonb_build_object(
      'todo_id', v_todo_id,
      'action_id', v_action_id,
      'codigo_ssw', p_codigo_ssw,
      'descricao_oc', v_oc.descricao,
      'texto_descricao', p_texto_descricao,
      'anexo_id', p_anexo_id,
      'tem_anexo', (p_anexo_id IS NOT NULL),
      'state_origem', v_card.state,
      'state_label', v_state_label,
      'oc_anterior_card', v_card.cod_ultima_ocorrencia,
      'proposta_payload', v_proposta_payload,
      'observacao', 'Lançamento emergencial — ' ||
        CASE v_state_label
          WHEN 'AGUARDANDO_VALIDACAO_HUMANA_oc20_recusar_flow' THEN
            'Larissa clicou RECUSAR FLOW SUGERIDO em card oc=20 (extravio localizado indevido). Corrigindo erro da operação.'
          ELSE 'bypassa fluxo padrão.'
        END
    )
  );

  -- 10. Enfileira no executor
  v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
    'todo_id', v_todo_id,
    'card_id', p_card_id,
    'action_id', v_action_id,
    'proposta_payload', v_proposta_payload,
    'aprovado_por', v_operador_id,
    'card_nf', v_card.nf,
    'card_ctrc', v_card.ctrc
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'todo_id', v_todo_id,
    'action_id', v_action_id,
    'card_id', p_card_id,
    'codigo_ssw', p_codigo_ssw,
    'descricao_oc', v_oc.descricao,
    'state_origem', v_card.state,
    'state_label', v_state_label,
    'tem_anexo', (p_anexo_id IS NOT NULL),
    'pgmq_msg_id', v_msg_id
  );
END;
$function$;

-- ── liberar_card_suspeito_lockado: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.liberar_card_suspeito_lockado(p_card_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
  v_state text;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  SELECT state INTO v_state FROM public.cards WHERE id = p_card_id;
  IF v_state IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'card não encontrado');
  END IF;

  UPDATE public.cards
  SET lock_aguardando_validacao = false,
      mudanca_suspeita = mudanca_suspeita || jsonb_build_object('vista_em', now(), 'liberado_em', now())
  WHERE id = p_card_id
    AND (assigned_operator_id = v_operador_id OR v_operador_id IS NULL);

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'MudancaSuspeitaLiberadaPeloOperador', 'human',
          COALESCE(v_operador_id::text, 'desconhecido'),
          jsonb_build_object('state_anterior', v_state));

  RETURN jsonb_build_object('ok', true, 'desbloqueado', true);
END;
$function$;

-- ── marcar_cancelamento_tratado: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.marcar_cancelamento_tratado(p_acao_id bigint, p_motivo text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_card_id uuid;
  v_assigned_op uuid;
  v_pagador text;
  v_segmento text;
  v_user uuid;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  v_user := auth.uid();

  SELECT aa.card_id, c.assigned_operator_id, c.pagador, c.segmento_codigo
    INTO v_card_id, v_assigned_op, v_pagador, v_segmento
  FROM public.acoes_agendadas aa
  JOIN public.cards c ON c.id = aa.card_id
  WHERE aa.id = p_acao_id AND aa.tipo = 'cancelar_reentrega_ssw';

  IF v_card_id IS NULL THEN
    RAISE EXCEPTION 'Ação % não encontrada ou não é do tipo cancelar_reentrega_ssw', p_acao_id;
  END IF;

  -- Caio 2026-05-18: valida que o operador atual tem acesso ao card.
  -- Reusa a mesma função que a RLS de cards usa pra consistência total.
  IF NOT public.card_visivel_pelo_operador_atual(v_assigned_op, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão pra operar cancelamento de outro operador (acao_id=%)', p_acao_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.acoes_agendadas
  SET
    status = 'tratado_manualmente',
    processed_at = now(),
    payload = payload
      || jsonb_build_object(
        'tratado_em', now()::text,
        'tratado_por', COALESCE(v_user::text, 'sistema'),
        'tratado_motivo', COALESCE(p_motivo, '')
      )
  WHERE id = p_acao_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_card_id,
    'CancelamentoReentregaTratadoManualmente',
    'operator',
    COALESCE(v_user::text, 'sistema'),
    jsonb_build_object('acao_id', p_acao_id, 'motivo', COALESCE(p_motivo, ''))
  );
END;
$function$;

-- ── marcar_card_nao_importante: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.marcar_card_nao_importante(p_card_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_card record;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, assigned_operator_id, state, nf, cod_ultima_ocorrencia
  INTO v_card FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor'
     AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra marcar card %', p_card_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Aceita TRATATIVA_PENDENTE ou TRANSFERIDO (caso operadora veja card
  -- transferido na timeline e queira limpar).
  IF v_card.state NOT IN ('TRATATIVA_PENDENTE', 'TRANSFERIDO') THEN
    RAISE EXCEPTION 'Só funciona em TRATATIVA_PENDENTE ou TRANSFERIDO (atual: %)', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.cards SET state = 'CANCELADO' WHERE id = p_card_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id,
    'CardMarcadoComoNaoImportante',
    'operator',
    v_operador_id::text,
    jsonb_build_object(
      'motivo', coalesce(p_motivo, '(sem motivo)'),
      'state_anterior', v_card.state,
      'state_novo', 'CANCELADO',
      'nf', v_card.nf,
      'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia
    )
  );

  RETURN jsonb_build_object('ok', true, 'card_id', p_card_id, 'state_novo', 'CANCELADO');
END;
$function$;

-- ── marcar_email_preexistente_visto: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.marcar_email_preexistente_visto(p_card_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  SELECT id INTO v_operador_id FROM public.operadores WHERE user_id = auth.uid();
  UPDATE public.cards
  SET email_preexistente_sugerido = email_preexistente_sugerido || jsonb_build_object('vista_em', now())
  WHERE id = p_card_id
    AND (assigned_operator_id = v_operador_id OR v_operador_id IS NULL)
    AND email_preexistente_sugerido IS NOT NULL;
END;
$function$;

-- ── marcar_retorno_inconclusivo: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.marcar_retorno_inconclusivo(p_card_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_card record;
  v_acoes_canc int;
  v_todos_canc int;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
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

  -- Cobrança automática REMOVIDA (2026-07-17): não agenda mais nada aqui.
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
      'cobranca_agendada', false,
      'cobranca_removida_em', '2026-07-17 (mig 298 — feature apagada)',
      'state_anterior', v_card.state,
      'state_novo', 'AGUARDANDO_CLIENTE'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', p_card_id,
    'acoes_canceladas', v_acoes_canc,
    'todos_cancelados', v_todos_canc,
    'cobranca_agendada', false
  );
END;
$function$;

-- ── registrar_feedback_interpretador_resposta_ia: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.registrar_feedback_interpretador_resposta_ia(p_card_id uuid, p_acertou boolean, p_decisao_correta_codigo_ssw integer DEFAULT NULL::integer, p_motivo_correcao text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid;
  v_operador_id uuid;   -- NOVO (mig 292): operadores.id (o que a FK exige), != auth.uid()
  v_nome text;
  v_id uuid;
  v_decisao_ia jsonb;
  v_oc_sugerida int;
  v_message_id uuid;
  v_codigo_oc int;
  v_motivo_limpo text;
  v_assigned uuid;
  v_pagador text;
  v_segmento text;
  v_tipo text;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Operador não autenticado' USING ERRCODE = '42501';
  END IF;

  -- FIX (mig 292, espelha mig 159): resolver operadores.id a partir de auth.uid().
  -- corrigido_por FKa operadores(id); gravar auth.uid() cru viola a FK.
  SELECT id, nome INTO v_operador_id, v_nome
  FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador % não cadastrado em public.operadores', v_user USING ERRCODE = '42501';
  END IF;

  SELECT assigned_operator_id, pagador, segmento_codigo, ia_sugestao_oc_resposta, cod_ultima_ocorrencia
    INTO v_assigned, v_pagador, v_segmento, v_decisao_ia, v_codigo_oc
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RAISE EXCEPTION 'Card % sem sugestão IA de resposta — feedback inaplicável', p_card_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.card_visivel_pelo_operador_atual(v_assigned, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão pra registrar feedback neste card' USING ERRCODE = '42501';
  END IF;

  v_oc_sugerida := (v_decisao_ia->>'oc_sugerida')::int;
  v_message_id  := NULLIF(v_decisao_ia->>'message_id','')::uuid;

  IF p_acertou THEN
    v_tipo := 'acertou_explicito';
    v_motivo_limpo := NULLIF(trim(COALESCE(p_motivo_correcao,'')), '');  -- opcional
  ELSE
    v_tipo := 'errou_explicito';
    v_motivo_limpo := NULLIF(trim(COALESCE(p_motivo_correcao,'')), '');
    IF v_motivo_limpo IS NULL OR length(v_motivo_limpo) < 10 THEN
      RAISE EXCEPTION 'Motivo da correção é obrigatório (mínimo 10 caracteres) quando IA errou' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.interpretador_resposta_cliente_feedback (
    card_id, message_id, oc_card_no_momento, tipo_feedback, decisao_ia,
    oc_sugerida_pela_ia, decisao_correta_codigo_ssw, motivo_correcao,
    corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_message_id, v_codigo_oc, v_tipo, v_decisao_ia,
    v_oc_sugerida, p_decisao_correta_codigo_ssw, v_motivo_limpo,
    v_operador_id, v_nome   -- FIX: operadores.id (não auth.uid())
  )
  ON CONFLICT (
    card_id,
    COALESCE(message_id, '00000000-0000-0000-0000-000000000000'::uuid),
    origem
  )
  DO UPDATE SET
    tipo_feedback = EXCLUDED.tipo_feedback,
    decisao_correta_codigo_ssw = EXCLUDED.decisao_correta_codigo_ssw,
    motivo_correcao = EXCLUDED.motivo_correcao,
    corrigido_por = EXCLUDED.corrigido_por,        -- = v_operador_id (corrigido)
    corrigido_por_nome = EXCLUDED.corrigido_por_nome,
    corrigido_em = now()
  RETURNING id INTO v_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'FeedbackInterpretadorRespostaCliente', 'operator', v_user::text,  -- actor_id textual (sem FK) — mantido
    jsonb_build_object(
      'feedback_id', v_id,
      'tipo_feedback', v_tipo,
      'oc_sugerida_pela_ia', v_oc_sugerida,
      'decisao_correta_codigo_ssw', p_decisao_correta_codigo_ssw,
      'motivo_correcao', v_motivo_limpo,
      'corrigido_por_nome', v_nome
    )
  );

  RETURN v_id;
END;
$function$;

-- ── registrar_motivo_divergencia: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.registrar_motivo_divergencia(p_card_id uuid, p_todo_id uuid, p_acao_key_sugerida text, p_acao_key_aprovada text, p_reason_code text, p_reason_text text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
  v_id uuid;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  v_operador_id := public.current_operador_id();
  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não identificado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.motivo_bank
    WHERE contexto = 'popup_divergencia'
      AND codigo = p_reason_code
      AND status = 'aprovado'
  ) THEN
    RAISE EXCEPTION 'Motivo inválido: %', p_reason_code;
  END IF;

  INSERT INTO public.divergencia_motivos (
    card_id, todo_id, operador_id,
    acao_key_sugerida, acao_key_aprovada, reason_code, reason_text
  ) VALUES (
    p_card_id, p_todo_id, v_operador_id,
    p_acao_key_sugerida, p_acao_key_aprovada, p_reason_code,
    nullif(trim(coalesce(p_reason_text, '')), '')
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

-- ── reportar_erro_lancamento: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.reportar_erro_lancamento(p_card_id uuid, p_codigo_oc_errada integer, p_codigo_oc_correta integer, p_descricao_oc_errada text DEFAULT NULL::text, p_data_oc_errada text DEFAULT NULL::text, p_base_responsavel text DEFAULT NULL::text, p_usuario_responsavel text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text, p_motivo_categoria text DEFAULT 'OC_DIFERENTE'::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid;
  v_nome text;
  v_id bigint;
  v_assigned_op uuid;
  v_pagador text;
  v_segmento text;
  v_oc_correta int;
  v_motivo_limpo text;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Operador não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT nome INTO v_nome FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_nome IS NULL THEN
    v_nome := 'desconhecido';
  END IF;

  SELECT assigned_operator_id, pagador, segmento_codigo
    INTO v_assigned_op, v_pagador, v_segmento
  FROM public.cards WHERE id = p_card_id;

  IF v_assigned_op IS NULL AND v_pagador IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.card_visivel_pelo_operador_atual(v_assigned_op, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão pra reportar erro neste card' USING ERRCODE = '42501';
  END IF;

  IF p_base_responsavel IS NULL OR p_usuario_responsavel IS NULL THEN
    RAISE EXCEPTION 'base_responsavel e usuario_responsavel são obrigatórios (vêm do historico_ssw)';
  END IF;

  IF p_motivo_categoria NOT IN ('OC_DIFERENTE','EVIDENCIA_INCOMPLETA') THEN
    RAISE EXCEPTION 'motivo_categoria inválido: % (válidos: OC_DIFERENTE | EVIDENCIA_INCOMPLETA)', p_motivo_categoria;
  END IF;

  v_motivo_limpo := NULLIF(trim(COALESCE(p_motivo, '')), '');

  -- Regras por categoria
  IF p_motivo_categoria = 'EVIDENCIA_INCOMPLETA' THEN
    -- OC correta deve ser a MESMA (a oc está certa, só a evidência está errada)
    v_oc_correta := p_codigo_oc_errada;

    -- Texto livre é OBRIGATÓRIO (sem ele, IA não consegue classificar)
    IF v_motivo_limpo IS NULL OR length(v_motivo_limpo) < 10 THEN
      RAISE EXCEPTION 'Pra erro de evidência, descreva o que exatamente estava errado (mínimo 10 caracteres)'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    -- OC_DIFERENTE: códigos devem ser distintos
    v_oc_correta := p_codigo_oc_correta;
    IF v_oc_correta = p_codigo_oc_errada THEN
      RAISE EXCEPTION 'Pra erro de OC, oc correta deve ser DIFERENTE da errada (se a oc está certa mas a evidência não, use motivo_categoria=EVIDENCIA_INCOMPLETA)'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.erros_lancamento_ssw (
    card_id, codigo_oc_errada, codigo_oc_correta,
    descricao_oc_errada, data_oc_errada,
    base_responsavel, usuario_responsavel,
    motivo, motivo_categoria,
    reportado_por, reportado_por_nome
  ) VALUES (
    p_card_id, p_codigo_oc_errada, v_oc_correta,
    p_descricao_oc_errada, p_data_oc_errada,
    p_base_responsavel, p_usuario_responsavel,
    v_motivo_limpo, p_motivo_categoria,
    v_user, v_nome
  )
  ON CONFLICT (card_id, codigo_oc_errada, data_oc_errada, usuario_responsavel)
  DO UPDATE SET
    codigo_oc_correta = EXCLUDED.codigo_oc_correta,
    motivo = EXCLUDED.motivo,
    motivo_categoria = EXCLUDED.motivo_categoria,
    reportado_por = EXCLUDED.reportado_por,
    reportado_por_nome = EXCLUDED.reportado_por_nome
  RETURNING id INTO v_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id,
    'ErroLancamentoReportado',
    'operator',
    v_user::text,
    jsonb_build_object(
      'erro_id', v_id,
      'codigo_oc_errada', p_codigo_oc_errada,
      'codigo_oc_correta', v_oc_correta,
      'motivo_categoria', p_motivo_categoria,
      'base_responsavel', p_base_responsavel,
      'usuario_responsavel', p_usuario_responsavel,
      'motivo', v_motivo_limpo
    )
  );

  RETURN v_id;
END;
$function$;

-- ── cadastrar_cliente_completo: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.cadastrar_cliente_completo(p_documento text, p_nome text, p_senha_tracking text DEFAULT NULL::text, p_contatos jsonb DEFAULT '[]'::jsonb, p_operador_responsavel_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_target_operador uuid;
  v_existing_operador uuid;
  v_contato jsonb;
  v_email_count int := 0;
  v_dominios text[] := '{}';
  v_dominio text;
  v_contatos_inseridos int := 0;
  v_senha_normalizada text;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  -- 1. Auth
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() AND ativo = true LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2. Resolve operador_responsavel
  IF v_operador_papel = 'gestor' THEN
    IF p_operador_responsavel_id IS NULL THEN
      RAISE EXCEPTION 'Gestor deve indicar p_operador_responsavel_id (qual operador é dono desse cliente)'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.operadores WHERE id = p_operador_responsavel_id AND ativo = true) THEN
      RAISE EXCEPTION 'Operador % não existe ou está inativo', p_operador_responsavel_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_target_operador := p_operador_responsavel_id;
  ELSE
    v_target_operador := v_operador_id;
  END IF;

  -- 3. Validações duras
  IF p_documento IS NULL OR p_documento !~ '^\d+$' OR length(p_documento) NOT IN (11, 14) THEN
    RAISE EXCEPTION 'Documento inválido: deve ter 11 (CPF) ou 14 (CNPJ) dígitos numéricos. Recebido: %', p_documento
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_nome IS NULL OR length(trim(p_nome)) = 0 THEN
    RAISE EXCEPTION 'Nome do cliente é obrigatório'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Caio 2026-05-15: senha de tracking SSW deixou de ser obrigatória.
  -- Tracking público deprecated; SSW interno (101) cobre. Normaliza vazio→NULL.
  v_senha_normalizada := NULLIF(trim(coalesce(p_senha_tracking, '')), '');

  IF p_contatos IS NULL OR jsonb_typeof(p_contatos) <> 'array' OR jsonb_array_length(p_contatos) = 0 THEN
    RAISE EXCEPTION 'Cliente precisa de pelo menos 1 contato (email obrigatório)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_contato IN SELECT * FROM jsonb_array_elements(p_contatos)
  LOOP
    IF v_contato->>'tipo' NOT IN ('email', 'whatsapp') THEN
      RAISE EXCEPTION 'Tipo de contato inválido: % (válidos: email, whatsapp)', v_contato->>'tipo'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_contato->>'tipo' = 'email' THEN
      IF v_contato->>'identificador' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RAISE EXCEPTION 'Email inválido: %', v_contato->>'identificador'
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_email_count := v_email_count + 1;
    END IF;
    IF v_contato->>'identificador' IS NULL OR length(trim(v_contato->>'identificador')) = 0 THEN
      RAISE EXCEPTION 'Identificador do contato é obrigatório'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;

  IF v_email_count = 0 THEN
    RAISE EXCEPTION 'Cliente precisa de pelo menos 1 contato do tipo email — sem ele Cockpit não envia mensagens'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 4. Checa propriedade existente (anti-roubo de cliente)
  SELECT operador_responsavel_id INTO v_existing_operador
  FROM public.tracking_credentials WHERE documento = p_documento;

  IF v_existing_operador IS NOT NULL AND v_existing_operador <> v_target_operador THEN
    IF v_operador_papel <> 'gestor' THEN
      RAISE EXCEPTION 'Cliente % já está cadastrado pra outro operador. Peça ao gestor pra transferir se necessário.', p_documento
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- 5. Upsert tracking_credentials (senha pode ser NULL)
  INSERT INTO public.tracking_credentials (
    documento, nome_amigavel, senha, notes, ativo,
    operador_responsavel_id, updated_by
  ) VALUES (
    p_documento, trim(p_nome), v_senha_normalizada, p_notes, true,
    v_target_operador, v_operador_id
  )
  ON CONFLICT (documento) DO UPDATE
    SET nome_amigavel = EXCLUDED.nome_amigavel,
        senha = EXCLUDED.senha,
        notes = EXCLUDED.notes,
        ativo = true,
        operador_responsavel_id = EXCLUDED.operador_responsavel_id,
        updated_by = EXCLUDED.updated_by;

  -- 5b. Upsert em clientes (pra aparecer na carteira/RLS)
  INSERT INTO public.clientes (cnpj_cpf, nome, ativo)
  VALUES (p_documento, trim(p_nome), true)
  ON CONFLICT (cnpj_cpf) DO UPDATE
    SET nome = EXCLUDED.nome, ativo = true, updated_at = now();

  -- 5c. Adiciona CNPJ na carteira do operador-dono (idempotente)
  UPDATE public.operadores
  SET carteira = array(SELECT DISTINCT unnest(carteira || p_documento))
  WHERE id = v_target_operador
    AND NOT (p_documento = ANY(carteira));

  -- 6. Rewrite contatos (DELETE + INSERT)
  DELETE FROM public.contatos_cliente WHERE documento_cliente = p_documento;

  FOR v_contato IN SELECT * FROM jsonb_array_elements(p_contatos)
  LOOP
    INSERT INTO public.contatos_cliente (
      documento_cliente, tipo, identificador, nome_pessoa, cargo, observacao,
      operador_responsavel_id, ativo, ordem, tipo_uso
    ) VALUES (
      p_documento,
      v_contato->>'tipo',
      lower(trim(v_contato->>'identificador')),
      v_contato->>'nome_pessoa',
      v_contato->>'cargo',
      v_contato->>'observacao',
      v_target_operador,
      true,
      coalesce((v_contato->>'ordem')::int, 1),
      coalesce(v_contato->>'tipo_uso', 'geral')
    );
    v_contatos_inseridos := v_contatos_inseridos + 1;

    -- Coleta domínios pra retorno
    IF v_contato->>'tipo' = 'email' THEN
      v_dominio := split_part(lower(trim(v_contato->>'identificador')), '@', 2);
      IF v_dominio <> '' AND NOT (v_dominio = ANY(v_dominios)) THEN
        v_dominios := array_append(v_dominios, v_dominio);
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'documento', p_documento,
    'operador_id', v_target_operador,
    'contatos_inseridos', v_contatos_inseridos,
    'dominios', v_dominios,
    'senha_tracking_setada', v_senha_normalizada IS NOT NULL
  );
END;
$function$;

-- ── desativar_cliente: guard injetado como 1ª linha do corpo ──
CREATE OR REPLACE FUNCTION public.desativar_cliente(p_documento text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_target_operador uuid;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() AND ativo = true LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT operador_responsavel_id INTO v_target_operador
  FROM public.tracking_credentials WHERE documento = p_documento;

  IF v_target_operador IS NULL THEN
    RAISE EXCEPTION 'Cliente % não encontrado', p_documento
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor' AND v_target_operador <> v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra desativar cliente %', p_documento
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.tracking_credentials SET ativo = false WHERE documento = p_documento;
  UPDATE public.contatos_cliente SET ativo = false WHERE documento_cliente = p_documento;

  RETURN jsonb_build_object('ok', true, 'documento', p_documento, 'ativo', false);
END;
$function$;

COMMIT;

-- Bloco 3: policies RESTRICTIVE de escrita — cards e card_events são quentes,
-- cada tabela na sua transação curta. Não toca as policies existentes (zero
-- regressão de visibilidade); RESTRICTIVE faz AND com as permissivas.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP POLICY IF EXISTS trava_visualizacao_upd ON public.cards;
CREATE POLICY trava_visualizacao_upd ON public.cards AS RESTRICTIVE
  FOR UPDATE TO authenticated
  USING ((SELECT public.current_operador_pode_executar()));
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
DROP POLICY IF EXISTS trava_visualizacao_ins ON public.card_events;
CREATE POLICY trava_visualizacao_ins ON public.card_events AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.current_operador_pode_executar()));
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
DROP POLICY IF EXISTS trava_visualizacao_ins ON public.contatos_cliente;
DROP POLICY IF EXISTS trava_visualizacao_upd ON public.contatos_cliente;
DROP POLICY IF EXISTS trava_visualizacao_del ON public.contatos_cliente;
CREATE POLICY trava_visualizacao_ins ON public.contatos_cliente AS RESTRICTIVE
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.current_operador_pode_executar()));
CREATE POLICY trava_visualizacao_upd ON public.contatos_cliente AS RESTRICTIVE
  FOR UPDATE TO authenticated USING ((SELECT public.current_operador_pode_executar()));
CREATE POLICY trava_visualizacao_del ON public.contatos_cliente AS RESTRICTIVE
  FOR DELETE TO authenticated USING ((SELECT public.current_operador_pode_executar()));

DROP POLICY IF EXISTS trava_visualizacao_ins ON public.contatos_escalonamento;
DROP POLICY IF EXISTS trava_visualizacao_upd ON public.contatos_escalonamento;
DROP POLICY IF EXISTS trava_visualizacao_del ON public.contatos_escalonamento;
CREATE POLICY trava_visualizacao_ins ON public.contatos_escalonamento AS RESTRICTIVE
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.current_operador_pode_executar()));
CREATE POLICY trava_visualizacao_upd ON public.contatos_escalonamento AS RESTRICTIVE
  FOR UPDATE TO authenticated USING ((SELECT public.current_operador_pode_executar()));
CREATE POLICY trava_visualizacao_del ON public.contatos_escalonamento AS RESTRICTIVE
  FOR DELETE TO authenticated USING ((SELECT public.current_operador_pode_executar()));
COMMIT;

-- Bloco final: asserts (só leitura + GUC local) -------------------------------
BEGIN;
DO $t$
DECLARE v_joao uuid; v_maria uuid; v_pegou boolean := false;
BEGIN
  SELECT user_id INTO v_joao  FROM operadores WHERE lower(email)='joao.penha@salexpress.com.br';
  SELECT user_id INTO v_maria FROM operadores WHERE nome='MARIA';
  IF v_joao IS NULL OR v_maria IS NULL THEN RAISE EXCEPTION 'ASSERT: operadores ausentes'; END IF;

  -- João (visualização) → false; RPC deve abortar com P0403
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_joao)::text, true);
  IF public.current_operador_pode_executar() THEN
    RAISE EXCEPTION 'ASSERT: João deveria estar travado';
  END IF;
  BEGIN
    PERFORM public.marcar_card_nao_importante(gen_random_uuid());
  EXCEPTION WHEN sqlstate 'P0403' THEN v_pegou := true;
  END;
  IF NOT v_pegou THEN RAISE EXCEPTION 'ASSERT: RPC não travou pro João'; END IF;

  -- Maria (operadora) → true (zero regressão)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_maria)::text, true);
  IF NOT public.current_operador_pode_executar() THEN
    RAISE EXCEPTION 'ASSERT: Maria NÃO pode ser travada';
  END IF;

  -- service_role / cron (sem uid) → true (crons intactos)
  PERFORM set_config('request.jwt.claims', NULL, true);
  IF NOT public.current_operador_pode_executar() THEN
    RAISE EXCEPTION 'ASSERT: sem uid deveria passar (cron)';
  END IF;

  RAISE NOTICE 'ASSERTS OK: João travado (P0403), Maria livre, cron livre';
END $t$;

COMMIT;
