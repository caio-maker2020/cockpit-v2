-- ============================================================================
-- Cockpit v2 — Múltiplas tratativas de e-mail no mesmo card (Caio 2026-06-17)
--
-- Contexto: a feature de "junção de e-mails por NF/assunto" (2026-06-16) faz um
-- card puxar e juntar mais de uma THREAD Gmail distinta quando elas falam da
-- mesma NF (ex.: NF 1084123 = thread "Recusa Total" com o pagador União Química
-- + thread "MINAS GERAIS SECRETARIA DE ESTADO" com o destinatário SES-MG). A
-- junção é desejada (a IA achou a reentrega na 2ª thread). O problema é só visual:
-- as 2 conversas apareciam misturadas numa lista cronológica única, confundindo
-- a operadora.
--
-- Este migration dá o backend pra:
--   1. Separar as tratativas por thread Gmail e expor isso pro front (RPC
--      listar_tratativas_email_do_card) com flag multiplas_tratativas + banner.
--   2. A operadora ESCOLHER qual tratativa vai responder/finalizar
--      (escolher_tratativa_email → grava cards.tratativa_email_escolhida + evento).
--   3. TRAVAR a aprovação de ação com e-mail enquanto houver >1 tratativa e
--      nenhuma escolhida (guard em aprovar_e_executar v5).
--   4. Rotear a resposta pra thread certa: o executor lê tratativa_email_escolhida
--      e responde NESSA thread (headers In-Reply-To/References/subject). O "Para"
--      (destinatário) é controlado pelo front via extras.email_destinatarios
--      (= responder_para da tratativa escolhida).
--
-- Single-tenant Sal Express. Não toca idempotência SSW nem confirmação SSW
-- (só roteamento de thread Gmail e UX de seleção).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Projeção da escolha humana no card. NULL = nenhuma tratativa escolhida
--    (card de thread única ou ainda não escolhido). Valor = gmail_thread_id.
-- ----------------------------------------------------------------------------
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS tratativa_email_escolhida text;

COMMENT ON COLUMN public.cards.tratativa_email_escolhida IS
  'gmail_thread_id da tratativa de e-mail que a operadora escolheu responder/finalizar '
  'quando o card juntou mais de uma thread (feature junção por NF/assunto). NULL = thread '
  'única ou não escolhido. Setado por escolher_tratativa_email() + evento '
  'TratativaEmailEscolhida. Lido pelo executor (carregarThreadDaTratativaAtual) pra responder '
  'na thread certa e pela guard de aprovar_e_executar.';

-- ----------------------------------------------------------------------------
-- 2. RPC de leitura pro front: agrupa inbound (messages_inbox) + outbound
--    (cards_emails_outbound) por gmail_thread_id e devolve as tratativas já
--    separadas, com meta (multiplas_tratativas, tratativa_escolhida) e marcando
--    qual thread a IA analisou (ia_sugestao_oc_resposta.message_id = id do inbound).
--    SECURITY INVOKER: respeita a RLS já existente das duas tabelas.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.listar_tratativas_email_do_card(p_card_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_ia_msg_id text;
  v_escolhida text;
  v_result jsonb;
BEGIN
  SELECT c.ia_sugestao_oc_resposta->>'message_id', c.tratativa_email_escolhida
    INTO v_ia_msg_id, v_escolhida
  FROM public.cards c
  WHERE c.id = p_card_id;

  WITH msgs AS (
    -- inbound (e-mails recebidos)
    SELECT
      NULLIF(mi.raw_payload->>'gmail_thread_id', '')                         AS thread_id,
      'inbound'::text                                                        AS direcao,
      mi.remetente                                                           AS endereco,
      mi.recebido_em                                                         AS ts,
      COALESCE(NULLIF(mi.raw_payload->>'subject', ''),
               NULLIF(mi.raw_payload->>'Subject', ''),
               '(sem assunto)')                                              AS assunto,
      mi.message_id_header                                                   AS message_id_header,
      LEFT(regexp_replace(COALESCE(mi.conteudo, ''), '\s+', ' ', 'g'), 280)  AS preview,
      (mi.id::text = v_ia_msg_id)                                            AS eh_msg_ia
    FROM public.messages_inbox mi
    WHERE mi.card_id = p_card_id AND mi.canal = 'email'
    UNION ALL
    -- outbound (e-mails que o Cockpit enviou)
    SELECT
      NULLIF(eo.gmail_thread_id, ''),
      'outbound'::text,
      eo.to_email,
      eo.sent_at,
      COALESCE(NULLIF(eo.subject, ''), '(sem assunto)'),
      eo.message_id_header,
      NULL,
      false
    FROM public.cards_emails_outbound eo
    WHERE eo.card_id = p_card_id
  ),
  msgs_grp AS (
    -- Uma "tratativa" = uma thread Gmail REAL (gmail_thread_id). Mensagens sem
    -- gmail_thread_id (legado/Postmark, fragmentos soltos) NÃO viram tratativa
    -- própria — poluiriam a tela com seções qtd=1 sem contexto. Cards 100%
    -- legados (sem thread em nenhuma msg) caem em tratativas=[] → front mantém
    -- a visão de lista única atual.
    SELECT m.thread_id AS grp, m.*
    FROM msgs m
    WHERE m.thread_id IS NOT NULL
  ),
  por_thread AS (
    SELECT
      MAX(g.thread_id)                                            AS gmail_thread_id,
      MIN(g.ts)                                                   AS primeiro_em,
      MAX(g.ts)                                                   AS ultimo_em,
      COUNT(*)                                                    AS qtd_mensagens,
      bool_or(g.eh_msg_ia)                                        AS analisada_pela_ia,
      -- direção/endereço da ÚLTIMA mensagem da thread (define se está aguardando
      -- nossa resposta = última msg é inbound de cliente externo).
      (ARRAY_AGG(g.direcao  ORDER BY g.ts DESC))[1]               AS ultima_direcao,
      (ARRAY_AGG(g.endereco ORDER BY g.ts DESC))[1]               AS ultimo_endereco,
      -- assunto base = do mais recente, sem prefixos Re:/Res:/Fwd:/Enc:/Fw:
      regexp_replace(
        (ARRAY_AGG(g.assunto ORDER BY g.ts DESC))[1],
        '^((RE|RES|FWD|ENC|FW)\s*:\s*)+', '', 'i')                AS assunto_base,
      -- responder_para = último inbound externo (ignora endereços @salexpress.com.br)
      (ARRAY_AGG(g.endereco ORDER BY g.ts DESC)
         FILTER (WHERE g.direcao = 'inbound'
                   AND g.endereco NOT ILIKE '%@salexpress.com.br'))[1] AS responder_para,
      ARRAY_AGG(DISTINCT g.endereco)
        FILTER (WHERE g.direcao = 'inbound'
                  AND g.endereco NOT ILIKE '%@salexpress.com.br')   AS participantes,
      jsonb_agg(jsonb_build_object(
        'direcao',           g.direcao,
        'endereco',          g.endereco,
        'assunto',           g.assunto,
        'ts',                g.ts,
        'message_id_header', g.message_id_header,
        'preview',           g.preview,
        'eh_msg_ia',         g.eh_msg_ia
      ) ORDER BY g.ts)                                            AS mensagens
    FROM msgs_grp g
    GROUP BY g.grp
  ),
  por_thread_flag AS (
    SELECT pt.*,
      -- aguardando_resposta = a conversa está parada esperando NÓS respondermos
      -- (última mensagem é inbound de cliente externo). É o que torna a tratativa
      -- "ativa"/ambígua quando há mais de uma. Threads cuja última msg é nossa
      -- (outbound) ou de finalização não exigem escolha.
      (pt.ultima_direcao = 'inbound'
        AND pt.ultimo_endereco IS NOT NULL
        AND pt.ultimo_endereco NOT ILIKE '%@salexpress.com.br') AS aguardando_resposta
    FROM por_thread pt
  )
  SELECT jsonb_build_object(
    'card_id',              p_card_id,
    -- Só conta/mostra tratativas com alguém externo pra responder (responder_para
    -- not null = teve inbound de cliente externo). Threads outbound-only (e-mail
    -- nosso sem resposta, qtd=1) NÃO são "tratativa pra escolher" — ficariam de
    -- ruído na tela.
    'total_tratativas',     (SELECT count(*) FROM por_thread_flag WHERE responder_para IS NOT NULL),
    'tratativas_ativas',    (SELECT count(*) FROM por_thread_flag WHERE aguardando_resposta),
    -- multiplas_tratativas (banner + trava + lock de botão) só quando há MAIS DE
    -- UMA tratativa ATIVA aguardando resposta — o caso ambíguo real. Threads
    -- sequenciais antigas (já respondidas/encerradas) NÃO disparam o banner.
    'multiplas_tratativas', (SELECT count(*) > 1 FROM por_thread_flag WHERE aguardando_resposta),
    'tratativa_escolhida',  v_escolhida,
    'tratativas', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'gmail_thread_id',  pt.gmail_thread_id,
        'assunto',          pt.assunto_base,
        'participantes',    COALESCE(to_jsonb(pt.participantes), '[]'::jsonb),
        'responder_para',   pt.responder_para,
        'qtd_mensagens',    pt.qtd_mensagens,
        'primeiro_em',      pt.primeiro_em,
        'ultimo_em',        pt.ultimo_em,
        'analisada_pela_ia', pt.analisada_pela_ia,
        'aguardando_resposta', pt.aguardando_resposta,
        'escolhida',        COALESCE(pt.gmail_thread_id IS NOT NULL AND pt.gmail_thread_id = v_escolhida, false),
        'mensagens',        pt.mensagens
      ) ORDER BY pt.aguardando_resposta DESC, pt.ultimo_em DESC)
      FROM por_thread_flag pt
      WHERE pt.responder_para IS NOT NULL
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.listar_tratativas_email_do_card(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_tratativas_email_do_card(uuid) TO authenticated;

COMMENT ON FUNCTION public.listar_tratativas_email_do_card(uuid) IS
  'Agrupa as mensagens de e-mail do card (inbound + outbound) por gmail_thread_id e '
  'devolve as tratativas separadas + meta (multiplas_tratativas, tratativa_escolhida, '
  'qual thread a IA analisou). Fonte do banner "ESSA NF TEVE MAIS DE UMA TRATATIVA NO '
  'E-MAIL LOCALIZADA" e da seleção da operadora no front. SECURITY INVOKER.';

-- ----------------------------------------------------------------------------
-- 3. RPC de escrita: operadora escolhe qual tratativa responder. p_thread_id
--    NULL limpa a escolha. SECURITY DEFINER pra gravar card_events (event
--    sourcing). Traduz auth.uid() -> operadores.id (FK), checa permissão.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.escolher_tratativa_email(
  p_card_id  uuid,
  p_thread_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id    uuid;
  v_operador_papel text;
  v_card           record;
  v_thread_existe  boolean;
BEGIN
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
$$;

REVOKE ALL ON FUNCTION public.escolher_tratativa_email(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.escolher_tratativa_email(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.escolher_tratativa_email(uuid, text) IS
  'Operadora escolhe qual tratativa de e-mail (gmail_thread_id) vai responder/finalizar '
  'num card com múltiplas threads. NULL limpa. Grava cards.tratativa_email_escolhida + '
  'evento TratativaEmailEscolhida. Destrava aprovar_e_executar pra ações com e-mail.';

-- ----------------------------------------------------------------------------
-- 4. aprovar_e_executar v5: guard que TRAVA aprovação de ação COM E-MAIL
--    enquanto o card tem >1 tratativa de e-mail e nenhuma foi escolhida.
--    Reproduz a v4 (mig 083) integralmente + adiciona o guard e lê
--    tratativa_email_escolhida no SELECT do card.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aprovar_e_executar(
  p_todo_id uuid,
  p_extras jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
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
BEGIN
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
    v_proposta_payload := jsonb_set(
      v_proposta_payload,
      '{args,extras}',
      p_extras,
      true
    );
  END IF;

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
$$;

REVOKE ALL ON FUNCTION public.aprovar_e_executar(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aprovar_e_executar(uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.aprovar_e_executar IS
  'Aprova todo + dispara executor. v5 (Caio 2026-06-17 mig 212): TRAVA ação com '
  'e-mail (tool ILIKE %email%) quando o card tem >1 tratativa de e-mail e nenhuma '
  'escolhida — força escolher_tratativa_email antes. v4 (mig 083) preservava '
  'cliente_respondeu_em / ia_sugestao_oc_resposta (limpeza no executor em sucesso).';
