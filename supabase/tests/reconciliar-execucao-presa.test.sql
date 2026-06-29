-- Teste de integração do watchdog de execução presa (mig 279, INV-031).
-- Roda em transação única com ROLLBACK → NÃO polui produção.
-- Rodar: psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/reconciliar-execucao-presa.test.sql
-- Cobre: (A) combo parcial oc33-feita/oc44-ausente → re-enfileira sem duplicar;
--        (B) sucesso=null STALE → reverte p/ humano; (C) e-mail → reverte.
BEGIN;

-- (A) Combo parcial: oc33 já lançada (sucesso=true), oc44 AUSENTE → reenfileirar.
DO $$
DECLARE
  v_card uuid := gen_random_uuid();
  v_todo uuid := gen_random_uuid();
  v_res jsonb; v_detect int; v_reenf int; v_msg int;
BEGIN
  INSERT INTO public.cards (id, nf, ctrc, canal_origem, state, lock_aguardando_validacao, cod_ultima_ocorrencia)
    VALUES (v_card, '999000111', 'TEST999-0', 'sistema', 'EXECUTANDO_ACAO', false, 49);
  INSERT INTO public.todos (id, card_id, action_id, descricao, status, approved_at, proposta_payload)
    VALUES (v_todo, v_card, gen_random_uuid(), 'combo 33+44 teste', 'aprovado', now() - interval '1 hour',
            jsonb_build_object('tool','lancar_combo_33_44','args', jsonb_build_object('codigo_ssw',33)));
  INSERT INTO public.acoes_executadas_ssw (card_id, codigo_oc, ctrc, todo_id, sucesso, iniciado_em, finalizado_em)
    VALUES (v_card, 33, 'TEST999-0', v_todo, true, now() - interval '50 min', now() - interval '50 min');

  v_res := public.reconciliar_execucoes_presas(0, 2, 10);
  v_detect := (v_res->>'detectados')::int; v_reenf := (v_res->>'reenfileirados')::int;

  IF v_detect < 1 THEN RAISE EXCEPTION '(A) FALHOU: nao detectou (detectados=%)', v_detect; END IF;
  IF v_reenf <> 1 THEN RAISE EXCEPTION '(A) FALHOU: combo parcial deveria re-enfileirar (reenfileirados=%)', v_reenf; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.card_events WHERE card_id=v_card AND event_type='ExecucaoReenfileirada' AND (payload->>'todo_id')=v_todo::text)
    THEN RAISE EXCEPTION '(A) FALHOU: sem ExecucaoReenfileirada'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.card_events WHERE card_id=v_card AND event_type='ExecucaoPresaDetectada' AND (payload->>'todo_id')=v_todo::text)
    THEN RAISE EXCEPTION '(A) FALHOU: sem ExecucaoPresaDetectada'; END IF;
  SELECT count(*) INTO v_msg FROM pgmq.q_agent_executor WHERE (message->>'todo_id')=v_todo::text;
  IF v_msg < 1 THEN RAISE EXCEPTION '(A) FALHOU: sem mensagem re-enfileirada (msgs=%)', v_msg; END IF;
  RAISE NOTICE '(A) OK combo parcial → reenfileirou (detect=% reenf=% fila=%)', v_detect, v_reenf, v_msg;
END $$;

-- (B) sucesso=null STALE → reverter (não re-enfileira cego; envelope abortaria).
DO $$
DECLARE
  v_card uuid := gen_random_uuid();
  v_todo uuid := gen_random_uuid();
  v_res jsonb; v_rev int;
BEGIN
  INSERT INTO public.cards (id, nf, ctrc, canal_origem, state, lock_aguardando_validacao, cod_ultima_ocorrencia)
    VALUES (v_card, '999000222', 'TEST999-2', 'sistema', 'EXECUTANDO_ACAO', false, 49);
  INSERT INTO public.todos (id, card_id, action_id, descricao, status, approved_at, proposta_payload)
    VALUES (v_todo, v_card, gen_random_uuid(), 'oc33 solo teste', 'aprovado', now() - interval '1 hour',
            jsonb_build_object('tool','lancar_oc33_solo_portal','args', jsonb_build_object('codigo_ssw',33)));
  -- linha sucesso=null ANTIGA (em voo zumbi)
  INSERT INTO public.acoes_executadas_ssw (card_id, codigo_oc, ctrc, todo_id, sucesso, iniciado_em)
    VALUES (v_card, 33, 'TEST999-2', v_todo, NULL, now() - interval '40 min');

  v_res := public.reconciliar_execucoes_presas(0, 2, 10);
  v_rev := (v_res->>'revertidos')::int;
  IF v_rev <> 1 THEN RAISE EXCEPTION '(B) FALHOU: null-stale deveria reverter (revertidos=%)', v_rev; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.card_events WHERE card_id=v_card AND event_type='ExecucaoRevertidaPorWatchdog' AND (payload->>'todo_id')=v_todo::text)
    THEN RAISE EXCEPTION '(B) FALHOU: sem ExecucaoRevertidaPorWatchdog'; END IF;
  -- reverter_acao_falhou ressuscita o todo p/ pendente + card p/ AGUARDANDO_VALIDACAO_HUMANA
  IF (SELECT state FROM public.cards WHERE id=v_card) <> 'AGUARDANDO_VALIDACAO_HUMANA'
    THEN RAISE EXCEPTION '(B) FALHOU: card nao voltou p/ AGUARDANDO_VALIDACAO_HUMANA'; END IF;
  RAISE NOTICE '(B) OK null-stale → reverteu p/ humano';
END $$;

-- (C) e-mail (mesmo via payload genérico) → reverter (v1 conservador).
DO $$
DECLARE
  v_card uuid := gen_random_uuid();
  v_todo uuid := gen_random_uuid();
  v_res jsonb; v_rev int;
BEGIN
  INSERT INTO public.cards (id, nf, ctrc, canal_origem, state, lock_aguardando_validacao, cod_ultima_ocorrencia)
    VALUES (v_card, '999000333', 'TEST999-3', 'sistema', 'EXECUTANDO_ACAO', false, 49);
  -- tool genérica MAS com destinatário de e-mail no payload → possibilidade de e-mail.
  INSERT INTO public.todos (id, card_id, action_id, descricao, status, approved_at, proposta_payload)
    VALUES (v_todo, v_card, gen_random_uuid(), 'oc com email teste', 'aprovado', now() - interval '1 hour',
            jsonb_build_object('tool','lancar_ocorrencia','args', jsonb_build_object('codigo_ssw',54,'email_destino','x@y.com')));

  v_res := public.reconciliar_execucoes_presas(0, 2, 10);
  v_rev := (v_res->>'revertidos')::int;
  IF v_rev <> 1 THEN RAISE EXCEPTION '(C) FALHOU: tool com email no payload deveria reverter (revertidos=%)', v_rev; END IF;
  RAISE NOTICE '(C) OK email-no-payload → reverteu';
END $$;

-- (D) tool DESCONHECIDA (fora da whitelist só-SSW) → reverter (default seguro).
DO $$
DECLARE
  v_card uuid := gen_random_uuid();
  v_todo uuid := gen_random_uuid();
  v_res jsonb; v_rev int;
BEGIN
  INSERT INTO public.cards (id, nf, ctrc, canal_origem, state, lock_aguardando_validacao, cod_ultima_ocorrencia)
    VALUES (v_card, '999000444', 'TEST999-4', 'sistema', 'EXECUTANDO_ACAO', false, 49);
  INSERT INTO public.todos (id, card_id, action_id, descricao, status, approved_at, proposta_payload)
    VALUES (v_todo, v_card, gen_random_uuid(), 'tool nova teste', 'aprovado', now() - interval '1 hour',
            jsonb_build_object('tool','tool_nova_qualquer','args', jsonb_build_object('codigo_ssw',99)));

  v_res := public.reconciliar_execucoes_presas(0, 2, 10);
  v_rev := (v_res->>'revertidos')::int;
  IF v_rev <> 1 THEN RAISE EXCEPTION '(D) FALHOU: tool fora da whitelist deveria reverter (revertidos=%)', v_rev; END IF;
  RAISE NOTICE '(D) OK tool desconhecida → reverteu';
END $$;

-- (E) todo status='executando' (crash entre executando e ACAO_EXECUTADA),
--     só-SSW, oc já lançada (sucesso=true) → reenfileirar (finaliza idempotente).
DO $$
DECLARE
  v_card uuid := gen_random_uuid();
  v_todo uuid := gen_random_uuid();
  v_res jsonb; v_detect int; v_reenf int;
BEGIN
  INSERT INTO public.cards (id, nf, ctrc, canal_origem, state, lock_aguardando_validacao, cod_ultima_ocorrencia)
    VALUES (v_card, '999000555', 'TEST999-5', 'sistema', 'EXECUTANDO_ACAO', false, 49);
  INSERT INTO public.todos (id, card_id, action_id, descricao, status, approved_at, proposta_payload)
    VALUES (v_todo, v_card, gen_random_uuid(), 'oc33 solo executando', 'executando', now() - interval '1 hour',
            jsonb_build_object('tool','lancar_oc33_solo_portal','args', jsonb_build_object('codigo_ssw',33)));
  INSERT INTO public.acoes_executadas_ssw (card_id, codigo_oc, ctrc, todo_id, sucesso, iniciado_em, finalizado_em)
    VALUES (v_card, 33, 'TEST999-5', v_todo, true, now() - interval '55 min', now() - interval '55 min');

  v_res := public.reconciliar_execucoes_presas(0, 2, 10);
  v_detect := (v_res->>'detectados')::int; v_reenf := (v_res->>'reenfileirados')::int;
  IF v_detect < 1 THEN RAISE EXCEPTION '(E) FALHOU: nao detectou todo executando (detectados=%)', v_detect; END IF;
  IF v_reenf <> 1 THEN RAISE EXCEPTION '(E) FALHOU: executando só-SSW deveria re-enfileirar p/ finalizar (reenfileirados=%)', v_reenf; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.card_events WHERE card_id=v_card AND event_type='ExecucaoReenfileirada' AND (payload->>'todo_status')='executando')
    THEN RAISE EXCEPTION '(E) FALHOU: ExecucaoReenfileirada sem todo_status=executando'; END IF;
  RAISE NOTICE '(E) OK todo executando só-SSW → reenfileirou p/ finalizar';
END $$;

-- (F) extras.skip_oc=true ("só notificar e-mail, não lança SSW") SEM outros campos
--     de e-mail → reverter (qualquer possibilidade de e-mail → humano).
DO $$
DECLARE
  v_card uuid := gen_random_uuid();
  v_todo uuid := gen_random_uuid();
  v_res jsonb; v_rev int;
BEGIN
  INSERT INTO public.cards (id, nf, ctrc, canal_origem, state, lock_aguardando_validacao, cod_ultima_ocorrencia)
    VALUES (v_card, '999000666', 'TEST999-6', 'sistema', 'EXECUTANDO_ACAO', false, 49);
  -- tool só-SSW (whitelisted) + extras.skip_oc=true e NENHUM outro campo de e-mail.
  INSERT INTO public.todos (id, card_id, action_id, descricao, status, approved_at, proposta_payload)
    VALUES (v_todo, v_card, gen_random_uuid(), 'skip_oc só email teste', 'aprovado', now() - interval '1 hour',
            jsonb_build_object('tool','lancar_ocorrencia','args', jsonb_build_object('codigo_ssw',49,'extras', jsonb_build_object('skip_oc', true))));

  v_res := public.reconciliar_execucoes_presas(0, 2, 10);
  v_rev := (v_res->>'revertidos')::int;
  IF v_rev <> 1 THEN RAISE EXCEPTION '(F) FALHOU: skip_oc=true deveria reverter (revertidos=%)', v_rev; END IF;
  RAISE NOTICE '(F) OK skip_oc=true (só e-mail) → reverteu';
END $$;

ROLLBACK;
