-- =============================================================================
-- 2026-08-27_363 — FEEDBACK OBRIGATORIO da oc 49 nao-reconhecida (Caio 27/08)
-- =============================================================================
-- "Conseguimos deixar obrigatorio o preenchimento?" — SIM: 1.254 decisoes
-- nao_reconhecido em 30d e ZERO feedbacks pelo caminho opcional. Este mig:
--   1. Tabela oc49_feedbacks (4 perguntas validadas pelo Caio; a CORRECAO nao
--      e perguntada — e capturada pela proxima aprovacao no card, como no veto);
--   2. RPC registrar_feedback_oc49_v2 (operador autenticado; valida taxonomia);
--   3. TRAVA na aprovar_e_executar: card 49 nao_reconhecido sem feedback =>
--      EXCEPTION FEEDBACK_OC49_OBRIGATORIO (front abre o modal e re-tenta).
--      Base = definicao ATUAL de prod (pg_get_functiondef 27/08) + gate;
--   4. monitor_sombra_oc49 ganha a secao 'feedbacks' (compilacao em tempo real
--      + match com a leitura do Sonnet do MESMO card — sombra).
-- Politica: cria estrutura nova MAS substitui 2 funcoes existentes (TIPO B) —
-- aplicacao somente com aval expresso do Caio no merge. Idempotente. Sem
-- BEGIN/COMMIT interno. skill: supabase-postgres-best-practices (RLS sem
-- policy = so service; SECURITY DEFINER com search_path fixo; indices).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.oc49_feedbacks (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id       uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  nf            text NOT NULL,
  operador_id   uuid NOT NULL,
  operador_nome text,
  categoria     text NOT NULL CHECK (categoria IN
    ('cobranca_retorno','pendencia_docs_indenizacao','instrucao_operacional',
     'devolucao_retorno','oc_lancada_errada','outro')),
  categoria_outro text,
  fontes        text[] NOT NULL DEFAULT '{}',
  recorrencia   text NOT NULL CHECK (recorrencia IN ('isolado','cliente','geral')),
  frase         text NOT NULL CHECK (length(trim(frase)) >= 10),
  consumido_por text,             -- regra/prompt que destilou este feedback
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_oc49_feedback_por_card UNIQUE (card_id),
  CONSTRAINT chk_categoria_outro CHECK (categoria <> 'outro' OR length(trim(coalesce(categoria_outro,''))) >= 5)
);
ALTER TABLE public.oc49_feedbacks ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_oc49_feedbacks_created ON public.oc49_feedbacks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oc49_feedbacks_categoria ON public.oc49_feedbacks (categoria);

-- ---------------------------------------------------------------------------
-- RPC de registro (chamada pelo modal; operador autenticado)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_feedback_oc49_v2(
  p_card_id uuid,
  p_categoria text,
  p_categoria_outro text,
  p_fontes text[],
  p_recorrencia text,
  p_frase text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_op_id uuid; v_op_nome text; v_nf text;
  v_fontes_validas text[] := ARRAY['texto_da_49','historico_ocorrencias','email_cliente','fora_do_cockpit','conhecimento_cliente'];
  f text;
BEGIN
  SELECT id, nome INTO v_op_id, v_op_nome FROM public.operadores WHERE user_id = auth.uid();
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'Operador nao encontrado pra auth.uid()=%', auth.uid();
  END IF;
  SELECT nf INTO v_nf FROM public.cards WHERE id = p_card_id;
  IF v_nf IS NULL THEN RAISE EXCEPTION 'Card % nao encontrado', p_card_id; END IF;
  FOREACH f IN ARRAY coalesce(p_fontes, '{}'::text[]) LOOP
    IF NOT (f = ANY(v_fontes_validas)) THEN RAISE EXCEPTION 'Fonte invalida: %', f; END IF;
  END LOOP;

  INSERT INTO public.oc49_feedbacks
    (card_id, nf, operador_id, operador_nome, categoria, categoria_outro, fontes, recorrencia, frase)
  VALUES
    (p_card_id, v_nf, v_op_id, v_op_nome, p_categoria, nullif(trim(coalesce(p_categoria_outro,'')),''),
     coalesce(p_fontes,'{}'::text[]), p_recorrencia, trim(p_frase))
  ON CONFLICT (card_id) DO UPDATE SET
    categoria = EXCLUDED.categoria, categoria_outro = EXCLUDED.categoria_outro,
    fontes = EXCLUDED.fontes, recorrencia = EXCLUDED.recorrencia, frase = EXCLUDED.frase;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (p_card_id, 'FeedbackOc49Registrado', 'operator', v_op_nome,
    jsonb_build_object('categoria', p_categoria, 'recorrencia', p_recorrencia,
                       'fontes', p_fontes, 'frase', trim(p_frase)));

  RETURN jsonb_build_object('ok', true, 'card_id', p_card_id);
END $fn$;

REVOKE ALL ON FUNCTION public.registrar_feedback_oc49_v2(uuid,text,text,text[],text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_feedback_oc49_v2(uuid,text,text,text[],text,text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- TRAVA na aprovar_e_executar (definicao atual de prod + gate do feedback)
-- ---------------------------------------------------------------------------
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


-- ---------------------------------------------------------------------------
-- monitor_sombra_oc49 v2 — ganha a secao 'feedbacks' (compilacao em tempo real)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.monitor_sombra_oc49(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.monitor_tokens
                  WHERE token = p_token AND escopo = 'oc49_sombra') THEN
    RAISE EXCEPTION 'token invalido';
  END IF;

  SELECT jsonb_build_object(
    'placar', (SELECT jsonb_build_object(
        'total',            count(*),
        'divergem',         count(*) FILTER (WHERE diverge = true),
        'concordam',        count(*) FILTER (WHERE diverge = false),
        'ia_falhou',        count(*) FILTER (WHERE diverge IS NULL),
        'vereditos_ia',     count(*) FILTER (WHERE veredito = 'ia'),
        'vereditos_codigo', count(*) FILTER (WHERE veredito = 'codigo'),
        'vereditos_empate', count(*) FILTER (WHERE veredito = 'empate'),
        'vereditos_ambos_errados', count(*) FILTER (WHERE veredito = 'ambos_errados'),
        'tokens_in',        coalesce(sum(custo_tokens_in), 0),
        'tokens_out',       coalesce(sum(custo_tokens_out), 0)
      ) FROM public.oc49_sombra),
    'casos', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'nf', s.nf, 'card_id', s.card_id,
        'em', to_char(s.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'),
        'codigo', s.decisao_codigo, 'ia', s.decisao_ia,
        'diverge', s.diverge, 'veredito', s.veredito,
        'tokens_in', s.custo_tokens_in, 'tokens_out', s.custo_tokens_out
      ) ORDER BY s.created_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM public.oc49_sombra ORDER BY created_at DESC LIMIT 200) s),
    'feedbacks', jsonb_build_object(
      'total', (SELECT count(*) FROM public.oc49_feedbacks),
      'por_categoria', (SELECT coalesce(jsonb_object_agg(categoria, n), '{}'::jsonb)
        FROM (SELECT categoria, count(*) n FROM public.oc49_feedbacks GROUP BY categoria) t),
      'por_recorrencia', (SELECT coalesce(jsonb_object_agg(recorrencia, n), '{}'::jsonb)
        FROM (SELECT recorrencia, count(*) n FROM public.oc49_feedbacks GROUP BY recorrencia) t),
      'match_ia', (SELECT jsonb_build_object('comparaveis', count(*),
          'bateram', count(*) FILTER (WHERE
            (f.categoria = 'cobranca_retorno'          AND s.decisao_ia->>'origem_da_49' = 'cobranca_de_retorno') OR
            (f.categoria = 'pendencia_docs_indenizacao' AND s.decisao_ia->>'origem_da_49' = 'indenizacao') OR
            (f.categoria = 'instrucao_operacional'      AND s.decisao_ia->>'origem_da_49' = 'operacao') OR
            (f.categoria = 'devolucao_retorno'          AND s.decisao_ia->>'origem_da_49' = 'devolucao')))
        FROM public.oc49_feedbacks f
        JOIN LATERAL (SELECT decisao_ia FROM public.oc49_sombra s
                       WHERE s.card_id = f.card_id ORDER BY s.created_at DESC LIMIT 1) s ON true
        WHERE f.categoria <> 'outro' AND f.categoria <> 'oc_lancada_errada'),
      'ultimos', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'nf', f.nf, 'categoria', f.categoria, 'categoria_outro', f.categoria_outro,
          'recorrencia', f.recorrencia, 'fontes', to_jsonb(f.fontes), 'frase', f.frase,
          'operador', f.operador_nome,
          'em', to_char(f.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI')
        ) ORDER BY f.created_at DESC), '[]'::jsonb)
        FROM (SELECT * FROM public.oc49_feedbacks ORDER BY created_at DESC LIMIT 30) f)
    )
  ) INTO v;
  RETURN v;
END $fn$;
