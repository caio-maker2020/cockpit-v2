-- =============================================================================
-- 2026-08-27_365 — GATE BLOQUEANTE da oc 33 incompleta (Caio 27/08, NF 660746)
-- =============================================================================
-- "quero que a 33 nos casos de extravio parcial so possa ser lancada completa.
-- O gate avisou que estava errado, mas mesmo assim a operadora conseguiu
-- aprovar." O gate de completude (NF 66193, modo AVISADO) vira PAREDE na
-- porta unica de aprovacao: meta.gate_oc33.bloqueada=true => EXCEPTION.
-- Vale pra 33-solo e combos (todas as propostas de 33 anotadas pelo gate).
-- O trilho autonomo ja barrava (conteudoCompletoParaVeto: dossie_incompleto).
-- Base = definicao ATUAL de prod (ja com a trava do feedback, mig 363).
-- Idempotente. Sem BEGIN/COMMIT. skill: supabase-postgres-best-practices.
-- =============================================================================

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

  -- ---------------------------------------------------------------------------
  -- Caio 2026-08-27: FEEDBACK OBRIGATORIO quando o agente NAO reconheceu a 49.
  -- 1.254 casos/30d sem nenhum aprendizado de volta (RPC opcional teve 0 usos).
  -- card_id = ciclo (cards renascem por ciclo), entao 1 feedback por card basta.
  -- O front captura o erro FEEDBACK_OC49_OBRIGATORIO e abre o formulario.
  -- ---------------------------------------------------------------------------
  IF EXISTS (
       SELECT 1 FROM public.cards c
        WHERE c.id = v_card.id
          AND c.cod_ultima_ocorrencia = 49
          AND c.analise_padrao_resultado->>'caso_oc49' = 'nao_reconhecido'
     )
     AND NOT EXISTS (SELECT 1 FROM public.oc49_feedbacks f WHERE f.card_id = v_card.id)
  THEN
    RAISE EXCEPTION 'FEEDBACK_OC49_OBRIGATORIO: o agente nao reconheceu esta 49 — descreva o caso antes de executar (o formulario abre ao aprovar).'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ---------------------------------------------------------------------------
  -- Caio 2026-08-27 (NF 660746): oc 33 em EXTRAVIO PARCIAL so sai COMPLETA.
  -- O gate NF-66193 anotava meta.gate_oc33.bloqueada=true em modo AVISADO e a
  -- operadora aprovou mesmo assim (33 sem descricao/valor ANTES da entrega;
  -- indenizacao voltou 20 dias depois cobrando 46->49 'DESCRICAO E VALOR').
  -- Agora e PAREDE: dossie incompleto NAO aprova, sem excecao.
  -- ---------------------------------------------------------------------------
  IF (v_todo.proposta_payload->'meta'->'gate_oc33'->>'bloqueada') = 'true' THEN
    RAISE EXCEPTION 'OC33_DOSSIE_INCOMPLETO: a oc 33 deste card so pode ser lancada COMPLETA — faltando: %. Complete o dossie (descricao, valor, romaneio) antes de aprovar.',
      coalesce(v_todo.proposta_payload->'meta'->'gate_oc33'->>'faltando', '?')
      USING ERRCODE = 'raise_exception';
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
$function$

;
