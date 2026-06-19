-- ============================================================================
-- Cockpit v2 — Conserta RPC `lancar_oc_emergencial_acao_executada`
-- Data: 2026-06-18  (Caio — NF 1119191, DUILIO)
--
-- BUG EM PRODUÇÃO desde a mig 195 (2026-06-09, migração portal 101):
--   A RPC ainda validava a oc destino contra `ocorrencias_dexpara` e exigia
--   `chave_cte` de 44 dígitos no agent_state. A mig 195 DROPOU a tabela
--   `ocorrencias_dexpara` e eliminou a dependência de `chave_cte` (portal
--   interno opção 101 usa card.ctrc + buscarNFInterno, código semântico direto).
--
--   Resultado: TODA tentativa de "Lançar oc emergencial / manual" estourava em
--   `relation "public.ocorrencias_dexpara" does not exist` (42P01) ANTES de
--   chegar no executor — independente da oc escolhida. Caso âncora: card da
--   NF 1119191 (oc=23, sem regra de propostas configurada) ficou em PARA FAZER
--   e o DUILIO não conseguiu lançar NENHUMA oc manualmente (print 2026-06-18).
--
-- CORREÇÃO (raiz, não só o caso):
--   1. Valida a oc destino contra `ocorrencias_dicionario` (fonte oficial pós
--      mig 204) — pega `descricao` de lá.
--   2. Remove o gate de `chave_cte` 44 dígitos E o gate `sem_chave_cte=true`.
--      Portal 101 não precisa de chave fiscal. Mesma filosofia já aplicada em
--      regras-auto-acao.ts (comentário "mig 195: removido gate sem_chave_cte").
--   3. Remove `codigo_api` do payload — executor usa `codigo_ssw` direto no
--      envelope lancarSswPortal (sem lookup_codigo_api, que morreu na mig 195).
--   4. `chave_cte` segue sendo extraída do agent_state e propagada no payload
--      (informativo/compat — o executor ignora pro portal), mas NÃO bloqueia
--      quando ausente/null.
--
-- Tudo o mais (gate v4 dos 3 cenários de state, anexo opcional, audit, pgmq)
-- preservado idêntico.
-- ============================================================================

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
  v_propostas_pendentes int;
  v_state_label text;
BEGIN
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
$$;

REVOKE ALL ON FUNCTION public.lancar_oc_emergencial_acao_executada(uuid, int, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lancar_oc_emergencial_acao_executada(uuid, int, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.lancar_oc_emergencial_acao_executada(uuid, int, text, uuid) IS
  'Caio 2026-06-18 (mig 220): lança oc emergencial/manual em card ACAO_EXECUTADA, '
  'AGUARDANDO_AGENTE (sem propostas) ou AGUARDANDO_VALIDACAO_HUMANA oc=20. Valida '
  'oc contra ocorrencias_dicionario (não mais ocorrencias_dexpara, dropada na mig '
  '195). Sem gate de chave_cte — portal 101 usa card.ctrc. Sem email — só '
  'lançamento da oc no SSW via envelope lancarSswPortal.';
