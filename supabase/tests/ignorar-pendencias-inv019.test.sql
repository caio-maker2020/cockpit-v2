-- Teste anti-regressão da RPC ignorar_pendencias_resposta_cliente (mig 287, INV-019).
-- Bug NF 1119469: a RPC movia p/ AGUARDANDO_CLIENTE sem checar cod_ultima_ocorrencia,
-- criando card em AGUARDANDO_CLIENTE + oc de relacionamento ≠54 (viola INV-019).
-- Roda em transação única com ROLLBACK → NÃO polui produção.
-- Rodar: psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ignorar-pendencias-inv019.test.sql
-- Cobre: (A) oc=19 relacionamento → FICA em AVH+lock, nunca AGUARDANDO_CLIENTE;
--        (B) oc=54 → volta p/ AGUARDANDO_CLIENTE (happy path preservado);
--        (C) oc=19 MAS lag pós-lançamento de 54 → volta p/ AGUARDANDO_CLIENTE (exclui lag).
BEGIN;

-- Helper local: cria um operador gestor + usuário auth e "loga" via JWT claim.
-- gestor bypassa a checagem de assigned_operator_id; SET request.jwt.claims faz
-- auth.uid() retornar o user_id do operador dentro desta transação.

-- (A) oc=19 (relacionamento ≠54) → deve FICAR em AVH+lock, cliente_respondeu_em zerado.
DO $$
DECLARE
  v_card uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_op   uuid := gen_random_uuid();
  v_res jsonb;
  v_state text; v_lock boolean; v_cre timestamptz; v_ia jsonb;
BEGIN
  INSERT INTO auth.users (instance_id, id, aud, role, email)
    VALUES ('00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated', 'teste-inv019a@x.com');
  INSERT INTO public.operadores (id, user_id, nome, email, papel)
    VALUES (v_op, v_user, 'TESTE_INV019_A', 'teste-inv019a@x.com', 'gestor');

  INSERT INTO public.cards (id, nf, ctrc, canal_origem, state, lock_aguardando_validacao,
                            cod_ultima_ocorrencia, cliente_respondeu_em, ia_sugestao_oc_resposta,
                            assigned_operator_id, bastao_data_ultima_ocorrencia)
    VALUES (v_card, '999111019', 'TESTX19-0', 'sistema', 'AGUARDANDO_VALIDACAO_HUMANA', true,
            19, now() - interval '10 min', jsonb_build_object('oc', 19),
            v_op, (now() - interval '1 day')::date);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  v_res := public.ignorar_pendencias_resposta_cliente(v_card, 'teste anti-regressao INV-019');

  SELECT state, lock_aguardando_validacao, cliente_respondeu_em, ia_sugestao_oc_resposta
    INTO v_state, v_lock, v_cre, v_ia
  FROM public.cards WHERE id = v_card;

  IF v_state <> 'AGUARDANDO_VALIDACAO_HUMANA' THEN
    RAISE EXCEPTION '(A) FALHOU: oc=19 deveria FICAR em AVH, foi p/ % (INV-019 violado)', v_state; END IF;
  IF v_lock <> true THEN
    RAISE EXCEPTION '(A) FALHOU: oc=19 deveria manter lock=true (AGUARDANDO VOCÊ)'; END IF;
  IF v_cre IS NOT NULL THEN
    RAISE EXCEPTION '(A) FALHOU: cliente_respondeu_em deveria ser NULL (sai de CLIENTE RESPONDEU)'; END IF;
  IF v_ia IS NOT NULL THEN
    RAISE EXCEPTION '(A) FALHOU: ia_sugestao_oc_resposta deveria ser NULL'; END IF;
  IF (v_res->>'permaneceu_em_aguardando_voce')::boolean <> true THEN
    RAISE EXCEPTION '(A) FALHOU: retorno deveria ter permaneceu_em_aguardando_voce=true'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.card_events
                 WHERE card_id=v_card
                   AND event_type='PendenciasRespostaIgnoradasMantidoEmAguardandoVoce'
                   AND payload->>'regra'='INV-019'
                   AND (payload->>'cod_ultima_ocorrencia')::int = 19) THEN
    RAISE EXCEPTION '(A) FALHOU: sem evento PendenciasRespostaIgnoradasMantidoEmAguardandoVoce (regra=INV-019, oc=19)'; END IF;
  RAISE NOTICE '(A) OK oc=19 relacionamento → FICOU em AVH+lock, sinais zerados, evento INV-019';
END $$;

-- (B) oc=54 → volta p/ AGUARDANDO_CLIENTE (happy path NÃO pode regredir).
DO $$
DECLARE
  v_card uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_op   uuid := gen_random_uuid();
  v_res jsonb; v_state text; v_lock boolean;
BEGIN
  INSERT INTO auth.users (instance_id, id, aud, role, email)
    VALUES ('00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated', 'teste-inv019b@x.com');
  INSERT INTO public.operadores (id, user_id, nome, email, papel)
    VALUES (v_op, v_user, 'TESTE_INV019_B', 'teste-inv019b@x.com', 'gestor');

  INSERT INTO public.cards (id, nf, ctrc, canal_origem, state, lock_aguardando_validacao,
                            cod_ultima_ocorrencia, cliente_respondeu_em, ia_sugestao_oc_resposta,
                            assigned_operator_id, bastao_data_ultima_ocorrencia)
    VALUES (v_card, '999111054', 'TESTX54-0', 'sistema', 'AGUARDANDO_VALIDACAO_HUMANA', true,
            54, now() - interval '10 min', jsonb_build_object('oc', 54),
            v_op, (now() - interval '1 day')::date);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  v_res := public.ignorar_pendencias_resposta_cliente(v_card, 'teste happy path oc54');

  SELECT state, lock_aguardando_validacao INTO v_state, v_lock
  FROM public.cards WHERE id = v_card;
  IF v_state <> 'AGUARDANDO_CLIENTE' THEN
    RAISE EXCEPTION '(B) FALHOU: oc=54 deveria voltar p/ AGUARDANDO_CLIENTE, foi p/ %', v_state; END IF;
  IF v_lock <> false THEN
    RAISE EXCEPTION '(B) FALHOU: oc=54 deveria ter lock=false em AGUARDANDO_CLIENTE'; END IF;
  IF (v_res->>'permaneceu_em_aguardando_voce')::boolean <> false THEN
    RAISE EXCEPTION '(B) FALHOU: oc=54 retorno deveria ter permaneceu_em_aguardando_voce=false'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.card_events
                 WHERE card_id=v_card AND event_type='PendenciasRespostaIgnoradas') THEN
    RAISE EXCEPTION '(B) FALHOU: sem evento PendenciasRespostaIgnoradas (happy path)'; END IF;
  RAISE NOTICE '(B) OK oc=54 → voltou p/ AGUARDANDO_CLIENTE (happy path preservado)';
END $$;

-- (C) oc=19 MAS lançou 54 depois (lag pós-54) → volta p/ AGUARDANDO_CLIENTE (exclusão de lag).
DO $$
DECLARE
  v_card uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_op   uuid := gen_random_uuid();
  v_res jsonb; v_state text;
BEGIN
  INSERT INTO auth.users (instance_id, id, aud, role, email)
    VALUES ('00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated', 'teste-inv019c@x.com');
  INSERT INTO public.operadores (id, user_id, nome, email, papel)
    VALUES (v_op, v_user, 'TESTE_INV019_C', 'teste-inv019c@x.com', 'gestor');

  INSERT INTO public.cards (id, nf, ctrc, canal_origem, state, lock_aguardando_validacao,
                            cod_ultima_ocorrencia, cliente_respondeu_em, ia_sugestao_oc_resposta,
                            assigned_operator_id, bastao_data_ultima_ocorrencia)
    VALUES (v_card, '999111099', 'TESTX99-0', 'sistema', 'AGUARDANDO_VALIDACAO_HUMANA', true,
            19, now() - interval '10 min', jsonb_build_object('oc', 19),
            v_op, (now() - interval '2 day')::date);
  -- 54 lançada com sucesso HOJE (>= bastao_data_ultima_ocorrencia) → é lag, não violação.
  INSERT INTO public.acoes_executadas_ssw (card_id, codigo_oc, ctrc, sucesso, iniciado_em, finalizado_em)
    VALUES (v_card, 54, 'TESTX99-0', true, now() - interval '1 hour', now() - interval '1 hour');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  v_res := public.ignorar_pendencias_resposta_cliente(v_card, 'teste lag pos-54');

  SELECT state INTO v_state FROM public.cards WHERE id = v_card;
  IF v_state <> 'AGUARDANDO_CLIENTE' THEN
    RAISE EXCEPTION '(C) FALHOU: lag pós-54 deveria voltar p/ AGUARDANDO_CLIENTE, foi p/ %', v_state; END IF;
  IF (v_res->>'permaneceu_em_aguardando_voce')::boolean <> false THEN
    RAISE EXCEPTION '(C) FALHOU: lag pós-54 retorno deveria ter permaneceu_em_aguardando_voce=false'; END IF;
  RAISE NOTICE '(C) OK oc=19 com lag pós-54 → voltou p/ AGUARDANDO_CLIENTE (exclusão de lag)';
END $$;

ROLLBACK;
