-- =============================================================================
-- 2026-08-27_366 — watchdog: detectar responder_thread_cliente como E-MAIL
-- =============================================================================
-- Caio 27/08 (NF 660746, e-mail duplicado ao cliente em 05/08): a deteccao
-- de e-mail do reconciliador (mig 279, restricao 4: "qualquer possibilidade
-- de e-mail => reverte, nunca re-executa") NAO listava o campo
-- responder_thread_cliente — usado quando a operadora escreve a resposta na
-- thread ao aprovar. O vigia classificou o todo travado da 55 como "so-SSW
-- seguro", reenfileirou, e o cliente recebeu o mesmo e-mail 2x.
--
-- Mudanca: 1 literal a mais no array da deteccao. Direcao estritamente
-- CONSERVADORA: todos COM o campo passam de "re-executa sozinho" para
-- "reverte pro humano" (o ramo seguro por desenho); todos SEM o campo tem
-- expressao IDENTICA — zero mudanca de comportamento.
-- Base = definicao ATUAL de prod (ja com a cerca da mig 361).
-- Guard: INV-119. Idempotente. Sem BEGIN/COMMIT.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.reconciliar_execucoes_presas(p_threshold_min integer DEFAULT 15, p_max_tentativas integer DEFAULT 2, p_recent_min integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cand record;
  rec record;
  v_acoes jsonb;
  v_terminal boolean;
  v_whitelisted boolean;
  v_tem_email boolean;
  v_tentativas int;
  v_decisao text;
  v_motivo text;
  v_msg_id bigint;
  v_detectados int := 0;
  v_reenfileirados int := 0;
  v_revertidos int := 0;
  v_aguardando int := 0;
  v_reconciliados int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('reconciliar_execucoes_presas')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'lock_em_uso');
  END IF;

  FOR cand IN
    SELECT c.id AS card_id, t.id AS todo_id, t.status AS todo_status, t.action_id, t.approved_by,
           t.proposta_payload, t.approved_at, c.nf AS card_nf, c.ctrc AS card_ctrc,
           (t.proposta_payload->>'tool') AS tool,
           GREATEST(1, round(extract(epoch FROM (now() - t.approved_at)) / 60))::int AS idade_min
    FROM public.cards c
    JOIN public.todos t ON t.card_id = c.id
    WHERE c.state = 'EXECUTANDO_ACAO'
      AND t.status IN ('aprovado', 'executando')
      AND t.approved_at < now() - make_interval(mins => p_threshold_min)
      -- Caio 2026-07-15 (mig 294): TETO de idade. Sem isso, um todo órfão de
      -- dias atrás (baixa perdida) era reenfileirado e virava falso "não lançada".
      -- Execução genuinamente presa é de minutos-a-horas; nunca dias. NF 710863.
      AND t.approved_at > now() - interval '24 hours'
      -- Caio 2026-08-26 (mig 361): card com execucao FRESCA nao e candidato.
      -- O join casa QUALQUER todo aprovado/executando velho do card; quando
      -- outra aprovacao acabou de por o card em EXECUTANDO_ACAO (janela de
      -- veto 17:45, cron do watchdog 17:50), a idade do RESIDUO velho (todo da
      -- 49 do extravio de 08:01 => "589min") era atribuida a execucao nova e o
      -- watchdog REVERTIA execucao saudavel em pleno voo. NFs-ancora 885480/
      -- 425770: revert 17:50:00, SSW confirmou 17:50:38/17:51:06 — a acao
      -- completou APESAR do revert (card marcado 'falhou' com acao feita).
      -- Se existe todo aprovado/executando FRESCO, o card esta EXECUTANDO,
      -- nao preso — watchdog nao toca; ele volta a ser candidato quando a
      -- execucao fresca terminar (sai de EXECUTANDO_ACAO) ou envelhecer.
      AND NOT EXISTS (
        SELECT 1 FROM public.todos tf
        WHERE tf.card_id = c.id
          AND tf.status IN ('aprovado', 'executando')
          AND tf.approved_at >= now() - make_interval(mins => p_threshold_min)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.card_events ce
        WHERE ce.card_id = c.id AND ce.event_type = 'ExecucaoReenfileirada'
          AND (ce.payload->>'todo_id') = t.id::text
          AND ce.created_at > now() - make_interval(mins => p_recent_min)
      )
  LOOP
    v_detectados := v_detectados + 1;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'codigo_oc', codigo_oc,
             'sucesso', sucesso,
             'idade_min', GREATEST(0, round(extract(epoch FROM (now() - COALESCE(finalizado_em, iniciado_em))) / 60))::int
           )), '[]'::jsonb)
      INTO v_acoes
      FROM public.acoes_executadas_ssw
      WHERE card_id = cand.card_id AND todo_id = cand.todo_id;

    SELECT EXISTS (
      SELECT 1 FROM public.card_events ce
      WHERE ce.card_id = cand.card_id
        AND (ce.payload->>'todo_id') = cand.todo_id::text
        AND ce.created_at >= cand.approved_at
        AND (ce.event_type LIKE 'Acao%'
             OR ce.event_type IN ('ComboPortalConcluido','StateTransicaoPosSucesso','TripeRejeitadoPeloGuard','RespostaEnviada'))
    ) INTO v_terminal;

    v_whitelisted := cand.tool IN ('lancar_oc33_solo_portal', 'lancar_combo_33_44', 'lancar_ocorrencia');

    v_tem_email := (
      cand.tool ILIKE '%email%'
      OR cand.tool = 'lancar_oc_e_enviar_email'
      OR COALESCE(cand.proposta_payload->'args', '{}'::jsonb) ?| ARRAY[
           'email_destino','email_destinatario','email_destinatarios','email_subject',
           'email_corpo','email_cc','email_anexos_ids','template_id','template_id_override','assunto_override']
      OR COALESCE(cand.proposta_payload->'args'->'extras', '{}'::jsonb) ?| ARRAY[
           'email_destino','email_destinatario','email_destinatarios','email_subject',
           'email_corpo','email_cc','email_anexos_ids','texto_email_customizado',
           'template_id','template_id_override','assunto_override',
           -- Caio 2026-08-27 (NF 660746): resposta escrita pela operadora na
           -- thread ao aprovar. FALTAVA aqui — o vigia reenfileirou o todo da
           -- 55 e o cliente recebeu o MESMO e-mail duas vezes. Com o campo na
           -- lista, ação travada com resposta-na-thread REVERTE pro humano
           -- (regra v1 da mig 279: qualquer possibilidade de e-mail nao
           -- re-executa sozinho).
           'responder_thread_cliente']
      OR COALESCE(cand.proposta_payload->'args'->'extras'->>'enviar_email','') = 'true'
      OR COALESCE(cand.proposta_payload->'args'->'extras'->>'skip_oc','') = 'true'
      OR COALESCE(cand.proposta_payload->'meta'->>'modo','') = 'completo'
      OR COALESCE(cand.proposta_payload->'meta'->>'modo_email','') <> ''
    );

    SELECT count(*) INTO v_tentativas FROM public.card_events
      WHERE card_id = cand.card_id AND event_type = 'ExecucaoReenfileirada'
        AND (payload->>'todo_id') = cand.todo_id::text;

    v_decisao := public._reconciliar_decidir(
      v_whitelisted, v_tem_email, v_acoes, v_tentativas, p_max_tentativas, p_recent_min);

    IF v_decisao = 'aguardar' THEN
      v_aguardando := v_aguardando + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (cand.card_id, 'ExecucaoPresaDetectada', 'system', 'reconciliador',
            jsonb_build_object('todo_id', cand.todo_id, 'tool', cand.tool,
              'todo_status', cand.todo_status, 'idade_min', cand.idade_min, 'decisao', v_decisao,
              'acoes_ssw', v_acoes, 'tentativas', v_tentativas,
              'terminal_event', v_terminal, 'whitelisted', v_whitelisted, 'tem_email', v_tem_email));

    IF v_decisao = 'reenfileirar' THEN
      PERFORM 1 FROM public.cards c JOIN public.todos t ON t.card_id = c.id
        WHERE c.id = cand.card_id AND t.id = cand.todo_id
          AND c.state = 'EXECUTANDO_ACAO' AND t.status IN ('aprovado', 'executando');
      IF FOUND THEN
        v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
          'todo_id', cand.todo_id, 'card_id', cand.card_id, 'action_id', cand.action_id,
          'proposta_payload', cand.proposta_payload, 'aprovado_por', cand.approved_by,
          'card_nf', cand.card_nf, 'card_ctrc', cand.card_ctrc));
        INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
        VALUES (cand.card_id, 'ExecucaoReenfileirada', 'system', 'reconciliador',
                jsonb_build_object('todo_id', cand.todo_id, 'tentativa', v_tentativas + 1,
                  'pgmq_msg_id', v_msg_id, 'todo_status', cand.todo_status));
        v_reenfileirados := v_reenfileirados + 1;
      END IF;

    ELSIF v_decisao = 'reverter' THEN
      v_motivo := 'Watchdog: execução presa em EXECUTANDO_ACAO há ' || cand.idade_min || 'min (todo ' || cand.todo_status || ') sem desfecho.'
        || CASE
             WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_acoes) e WHERE (e->>'sucesso') IS NULL)
               THEN ' ATENÇÃO: oc em voo/indeterminado (sucesso=null) — confira no SSW ANTES de reaprovar.'
             WHEN NOT v_whitelisted THEN ' Tool "' || COALESCE(cand.tool,'?') || '" fora da whitelist só-SSW — confira/execute manualmente.'
             WHEN v_tem_email THEN ' Ação envolve e-mail — confira se o e-mail e a oc saíram ANTES de reaprovar.'
             WHEN v_tentativas >= p_max_tentativas THEN ' Re-enfileirado ' || v_tentativas || 'x sem sucesso.'
             ELSE ' Confira o estado no SSW antes de reaprovar.'
           END;
      PERFORM public.reverter_acao_falhou(cand.todo_id, v_motivo);
      INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
      VALUES (cand.card_id, 'ExecucaoRevertidaPorWatchdog', 'system', 'reconciliador',
              jsonb_build_object('todo_id', cand.todo_id, 'motivo', v_motivo,
                'acoes_ssw', v_acoes, 'tentativas', v_tentativas,
                'whitelisted', v_whitelisted, 'tem_email', v_tem_email, 'todo_status', cand.todo_status));
      v_revertidos := v_revertidos + 1;
    END IF;
  END LOOP;

  FOR rec IN
    SELECT c.id AS card_id, c.state
    FROM public.cards c
    WHERE c.state <> 'EXECUTANDO_ACAO'
      AND EXISTS (
        SELECT 1 FROM public.card_events ce
        WHERE ce.card_id = c.id AND ce.event_type = 'ExecucaoReenfileirada'
          AND ce.created_at > now() - interval '2 hours')
      AND NOT EXISTS (
        SELECT 1 FROM public.card_events ce2
        WHERE ce2.card_id = c.id AND ce2.event_type = 'ExecucaoReconciliada'
          AND ce2.created_at > (
            SELECT max(ce3.created_at) FROM public.card_events ce3
            WHERE ce3.card_id = c.id AND ce3.event_type = 'ExecucaoReenfileirada'))
  LOOP
    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (rec.card_id, 'ExecucaoReconciliada', 'system', 'reconciliador',
            jsonb_build_object('state_atual', rec.state,
              'observacao', 'Re-enfileiramento do watchdog resolveu — card saiu de EXECUTANDO_ACAO.'));
    v_reconciliados := v_reconciliados + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'detectados', v_detectados,
    'reenfileirados', v_reenfileirados, 'revertidos', v_revertidos,
    'aguardando', v_aguardando, 'reconciliados', v_reconciliados);
END;
$function$

;
