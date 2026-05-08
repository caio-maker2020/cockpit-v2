-- ============================================================================
-- Cockpit v2 — RPC `lancar_oc_emergencial_acao_executada` v2 (com anexo)
-- Data: 2026-05-08
--
-- Caio 2026-05-08: SSW WebAPI suporta `imagem` (base64 JPEG/PDF) no body de
-- /api/ocorrenciaParceiro. Larissa precisa lançar oc=33 (e outras emergenciais)
-- anexando comprovante/foto pra setor de Perdas/Devolução ver direto no SSW.
--
-- Mudança: adiciona parâmetro opcional `p_anexo_id uuid`. Quando passado,
-- inclui em proposta_payload.args.extras.anexo_id. Executor (Deno) lê esse
-- id, baixa do bucket `email_anexos` (privado), converte pra base64 e envia
-- pro SSW como `imagem`. Após sucesso, deleta do bucket (privacidade).
--
-- Combinações cobertas (todas válidas):
--   - só oc                 (p_texto_descricao=NULL, p_anexo_id=NULL)
--   - oc + texto            (p_texto_descricao!=NULL, p_anexo_id=NULL)
--   - oc + imagem           (p_texto_descricao=NULL, p_anexo_id!=NULL)
--   - oc + texto + imagem   (ambos preenchidos)
--
-- Backward-compat: assinatura antiga (uuid, int, text) continua válida — RPC
-- nova é overload com 4º parâmetro DEFAULT NULL.
-- ============================================================================

-- Drop signature antiga pra evitar ambiguidade (Postgres pode escolher errado
-- se houver duas funções com mesmo nome e prefixo de args). A nova função
-- com 4 args + DEFAULT NULL no último cobre 100% dos calls antigos.
DROP FUNCTION IF EXISTS public.lancar_oc_emergencial_acao_executada(uuid, int, text);

CREATE OR REPLACE FUNCTION public.lancar_oc_emergencial_acao_executada(
  p_card_id uuid,
  p_codigo_ssw int,
  p_texto_descricao text DEFAULT NULL,
  p_anexo_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
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
BEGIN
  -- 1. Auth
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2. Card check
  SELECT id, assigned_operator_id, state, nf, ctrc, sem_chave_cte, agent_state
  INTO v_card FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id;
  END IF;

  IF v_operador_papel <> 'gestor' AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra agir no card %', p_card_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_card.state <> 'ACAO_EXECUTADA' THEN
    RAISE EXCEPTION 'RPC emergencial só roda em cards em ACAO_EXECUTADA. Card % está em state=%', p_card_id, v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_card.sem_chave_cte = true THEN
    RAISE EXCEPTION 'Card NF % sem chave fiscal cadastrada — RPA OPC 455 ainda não importou.', v_card.nf
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 3. Validar oc — precisa estar em ocorrencias_dexpara.ativo=true
  SELECT codigo_ssw, codigo_api, descricao INTO v_oc
  FROM public.ocorrencias_dexpara
  WHERE codigo_ssw = p_codigo_ssw AND ativo = true;

  IF v_oc.codigo_ssw IS NULL THEN
    RAISE EXCEPTION 'Código SSW % não está na lista de ocorrências lançáveis (ocorrencias_dexpara ativo=true)', p_codigo_ssw
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 4. Extrai chave_cte + cnpj_remetente do agent_state
  v_chave_cte := v_card.agent_state->>'chave_cte';
  v_cnpj_remetente := COALESCE(
    v_card.agent_state->>'cnpj_remetente',
    v_card.agent_state->>'cnpj_pagador'
  );

  IF v_chave_cte IS NULL OR length(v_chave_cte) <> 44 THEN
    RAISE EXCEPTION 'Card NF % sem chave_cte válida no agent_state', v_card.nf
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 5. Se anexo passado, valida (deve existir no bucket e não estar deletado)
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

    -- SSW WebAPI aceita imagem em formatos JPEG e PDF (doc oficial). Filtra
    -- aqui pra falhar rápido se a operadora subiu PNG/GIF por engano.
    IF v_anexo.mime_type NOT IN ('image/jpeg', 'image/jpg', 'image/pjpeg', 'application/pdf') THEN
      RAISE EXCEPTION 'Anexo % com mime_type % não suportado pelo SSW (apenas JPEG/PDF)',
        p_anexo_id, v_anexo.mime_type
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  -- 6. Monta extras: texto livre + (opcional) referência ao anexo
  v_extras := '{}'::jsonb;
  IF p_texto_descricao IS NOT NULL AND length(trim(p_texto_descricao)) > 0 THEN
    v_extras := v_extras || jsonb_build_object('texto_descricao', p_texto_descricao);
  END IF;
  IF p_anexo_id IS NOT NULL THEN
    v_extras := v_extras || jsonb_build_object('anexo_id', p_anexo_id::text);
  END IF;

  -- 7. Monta proposta_payload (mesmo formato do flow normal)
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
      'modo', 'emergencial_acao_executada',
      'origem', 'lancar_oc_emergencial_acao_executada',
      'oc_anterior_card', v_card.agent_state->>'cod_ultima_ocorrencia',
      'tem_anexo', (p_anexo_id IS NOT NULL)
    ),
    'rationale', 'Caio 2026-05-08: lançamento emergencial em card ACAO_EXECUTADA — oc=' || p_codigo_ssw::text
      || CASE WHEN p_anexo_id IS NOT NULL THEN ' com anexo (imagem/PDF) pro SSW' ELSE '' END
      || '.'
  );

  -- 8. Cria todo + action_id já aprovado
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

  -- 9. Audit event
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
      'proposta_payload', v_proposta_payload,
      'observacao', 'Lançamento emergencial em card ACAO_EXECUTADA — bypassa lock; pode incluir anexo (JPEG/PDF) pra SSW.'
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
    'tem_anexo', (p_anexo_id IS NOT NULL),
    'pgmq_msg_id', v_msg_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lancar_oc_emergencial_acao_executada(uuid, int, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lancar_oc_emergencial_acao_executada(uuid, int, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.lancar_oc_emergencial_acao_executada(uuid, int, text, uuid) IS
  'Caio 2026-05-08: lança oc emergencial em card ACAO_EXECUTADA (bypassa lock). '
  'Larissa escolhe da lista de ocorrencias_dexpara ativas, opcionalmente com '
  'texto livre (descricao) e/ou anexo (JPEG/PDF — vira `imagem` base64 no SSW). '
  'Sem email — só lançamento. Após sucesso SSW, executor reseta '
  'acao_executada_em=now() e deleta o anexo do bucket por privacidade.';
