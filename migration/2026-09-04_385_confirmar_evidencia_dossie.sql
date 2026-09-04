-- =============================================================================
-- 2026-09-04_385 — RPC confirmar_evidencia_dossie (saída legítima do gate da 33)
-- =============================================================================
-- Carlos/Caio 2026-09-04. Âncora NF 632603 / DUILIO.
--
-- PROBLEMA: a mig 365 tornou a oc 33 incompleta uma PAREDE em aprovar_e_executar
-- e, ao fazer isso, tornou inalcançável o escape hatch do ADR 0023 (o enforce do
-- executor, que aceita extras.forcar_oc33_dossie_incompleto, está atrás da flag
-- extravio_parcial_gate_enforce = OFF, e a parede dispara ANTES dele). Somando a
-- isso: nenhuma função no banco escrevia o dossiê, e o front nunca implementou o
-- estado "AVISADO". Resultado: 270 todos pendentes travados, botão habilitado que
-- sempre falha e ZERO caminho para o operador destravar.
--
-- Na NF 632603 o cliente ANEXOU o documento e escreveu "segue minuta"; a IA
-- registrou por escrito "falta confirmação se o anexo PDF é o romaneio". O
-- documento está lá — falta um humano dizer que é ele.
--
-- DECISÃO: NÃO criar botão de "forçar" (reabriria a NF 660746 — indenização
-- aberta incompleta). Criar o caminho de CONFIRMAR A EVIDÊNCIA: o operador
-- aponta o anexo/trecho e o dossiê fica completo DE VERDADE, com autoria
-- registrada. A parede da mig 365 continua intacta (INV-118 preservado).
--
-- GARANTIAS DESTA FUNÇÃO:
--   - fail-closed: romaneio/anexo só conta se o anexo EXISTIR em email_anexos
--     como inbound DAQUELE card (nada de filename digitado à mão);
--   - MONOTÔNICA: nunca derruba evidência já presente (espelha mergeEvidencia);
--   - só o dono do card ou gestor; respeita assert_pode_executar() (modo visão);
--   - só age em card de EXTRAVIO PARCIAL (agent_state.extravio_parcial existe);
--   - recarimba meta.gate_oc33 dos todos ATIVOS de oc 33 do card — sem isso a
--     confirmação não destrava nada, porque a parede lê o CARIMBO, não o dossiê;
--   - evento em card_events (event sourcing, convenção nº 1).
--
-- TIPO A: função NOVA (não substitui objeto existente). NÃO toca
-- aprovar_e_executar — o carimbo sugestao_vigente da mig 377/378 fica intacto.
-- Idempotente. Sem BEGIN/COMMIT.
-- Rollback: DROP FUNCTION public.confirmar_evidencia_dossie(uuid, text, uuid, text, text);
-- =============================================================================

CREATE OR REPLACE FUNCTION public.confirmar_evidencia_dossie(
  p_card_id uuid,
  p_tipo text,
  p_message_inbox_id uuid DEFAULT NULL,
  p_filename text DEFAULT NULL,
  p_texto text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_card record;
  v_ep jsonb;
  v_dossie jsonb;
  v_caso text;
  v_anexo record;
  v_msg record;
  v_entrada jsonb;
  v_completo boolean;
  v_faltando text[];
  v_todos_recarimbados int := 0;
  t record;
  v_tool text;
  v_tipo_acao text;
  v_codigo int;
  v_eh_oc33 boolean;
  v_natureza text;
  v_bloqueada boolean;
  v_faltando_todo text[];
BEGIN
  IF p_tipo NOT IN ('romaneio', 'descricao', 'valor') THEN
    RAISE EXCEPTION 'tipo inválido: % (esperado romaneio|descricao|valor)', p_tipo
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)

  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;
  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, nf, assigned_operator_id, agent_state
  INTO v_card FROM public.cards WHERE id = p_card_id;
  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor' AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra confirmar evidência do card %', p_card_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_ep := v_card.agent_state -> 'extravio_parcial';
  IF v_ep IS NULL OR jsonb_typeof(v_ep) <> 'object' THEN
    RAISE EXCEPTION 'Card NF % não é de extravio parcial — nada a confirmar no dossiê', v_card.nf
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_dossie := COALESCE(v_ep -> 'dossie', '{}'::jsonb);
  v_caso   := v_ep ->> 'caso';

  -- MONOTÔNICO: evidência já presente não é reescrita nem derrubada.
  IF (v_dossie -> p_tipo ->> 'presente') = 'true' THEN
    RETURN jsonb_build_object(
      'ok', true, 'ja_estava_presente', true, 'tipo', p_tipo, 'card_id', p_card_id
    );
  END IF;

  IF p_message_inbox_id IS NOT NULL THEN
    -- FAIL-CLOSED: o anexo tem de existir de verdade, inbound, NESTE card.
    SELECT a.filename, a.mime_type, a.size_bytes
    INTO v_anexo
    FROM public.email_anexos a
    WHERE a.card_id = p_card_id
      AND a.message_inbox_id = p_message_inbox_id
      AND a.origem = 'inbound'
      AND (p_filename IS NULL OR a.filename = p_filename)
    LIMIT 1;

    IF v_anexo.filename IS NULL THEN
      RAISE EXCEPTION 'Anexo % não encontrado como inbound no card NF % — evidência não confirmada',
        COALESCE(p_filename, p_message_inbox_id::text), v_card.nf
        USING ERRCODE = 'no_data_found';
    END IF;

    SELECT m.raw_payload, m.recebido_em INTO v_msg
    FROM public.messages_inbox m WHERE m.id = p_message_inbox_id;

    v_entrada := jsonb_strip_nulls(jsonb_build_object(
      'presente', true,
      'fonte', 'anexo',
      'filename', v_anexo.filename,
      'mime_type', v_anexo.mime_type,
      'size_bytes', v_anexo.size_bytes,
      'message_inbox_id', p_message_inbox_id,
      'gmail_message_id', v_msg.raw_payload ->> 'gmail_message_id',
      'gmail_thread_id', v_msg.raw_payload ->> 'gmail_thread_id',
      'operador_id', v_msg.raw_payload ->> 'operador_id',
      'visto_em', COALESCE(v_msg.recebido_em, now())::text,
      'confirmado_por', v_operador_id::text,
      'confirmado_em', now()::text
    ));
  ELSE
    -- Sem anexo: só descrição/valor podem vir de texto. O ROMANEIO é DOCUMENTO —
    -- espelha a regra do módulo puro (nunca conta sem anexo real).
    IF p_tipo = 'romaneio' THEN
      RAISE EXCEPTION 'O romaneio é um documento: informe o anexo (message_inbox_id) do e-mail do cliente'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_texto IS NULL OR length(btrim(p_texto)) < 3 THEN
      RAISE EXCEPTION 'Texto da evidência % vazio ou curto demais', p_tipo
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_entrada := jsonb_build_object(
      'presente', true,
      'fonte', 'corpo',
      'texto_bruto', left(p_texto, 4000),
      'visto_em', now()::text,
      'confirmado_por', v_operador_id::text,
      'confirmado_em', now()::text
    );
  END IF;

  v_dossie := jsonb_set(v_dossie, ARRAY[p_tipo], v_entrada, true);

  v_completo := (v_dossie -> 'romaneio' ->> 'presente') = 'true'
            AND (v_dossie -> 'descricao' ->> 'presente') = 'true'
            AND (v_dossie -> 'valor'     ->> 'presente') = 'true';
  v_dossie := jsonb_set(v_dossie, '{completo}', to_jsonb(v_completo), true);

  -- rótulos na MESMA ordem de avaliarDossie (romaneio -> descrição -> valor)
  v_faltando := ARRAY(
    SELECT r FROM (
      SELECT 1 AS ord, 'romaneio de coleta assinado' AS r
        WHERE (v_dossie->'romaneio'->>'presente') IS DISTINCT FROM 'true'
      UNION ALL SELECT 2, 'descrição dos itens'
        WHERE (v_dossie->'descricao'->>'presente') IS DISTINCT FROM 'true'
      UNION ALL SELECT 3, 'valor dos itens'
        WHERE (v_dossie->'valor'->>'presente') IS DISTINCT FROM 'true'
    ) s ORDER BY ord
  );

  UPDATE public.cards
  SET agent_state = jsonb_set(
        COALESCE(agent_state, '{}'::jsonb),
        '{extravio_parcial}',
        (COALESCE(agent_state -> 'extravio_parcial', '{}'::jsonb))
          || jsonb_build_object('dossie', v_dossie,
                                'fase', CASE WHEN v_completo THEN 'completo' ELSE 'coletando' END),
        true
      )
  WHERE id = p_card_id;

  -- -------------------------------------------------------------------------
  -- RECARIMBA os todos ATIVOS de oc 33. A parede da mig 365 lê
  -- proposta_payload.meta.gate_oc33 (CARIMBO), não o dossiê vivo — sem este
  -- passo a confirmação não destravaria absolutamente nada.
  -- Espelha classificarOc33 + decidirGateOc33 do módulo puro.
  -- -------------------------------------------------------------------------
  FOR t IN
    SELECT id, proposta_payload FROM public.todos
    WHERE card_id = p_card_id AND status IN ('pendente', 'aprovado')
  LOOP
    CONTINUE WHEN t.proposta_payload IS NULL;

    v_tool := COALESCE(t.proposta_payload ->> 'tool', t.proposta_payload ->> 'tool_override');
    v_tipo_acao := COALESCE(t.proposta_payload -> 'meta' ->> 'tipo_acao',
                            t.proposta_payload ->> 'tipo_acao');
    v_codigo := NULLIF(COALESCE(
      t.proposta_payload -> 'args' ->> 'codigo_ssw',
      t.proposta_payload ->> 'codigo_ssw',
      t.proposta_payload ->> 'codigo_ssw_proposto'
    ), '')::int;

    v_eh_oc33 := v_codigo = 33
      OR v_tool IN ('lancar_combo_33_44', 'lancar_oc33_solo_portal',
                    'enviar_email_livre_e_lancar_oc33_portal',
                    'enviar_email_e_lancar_33_romaneio_interno')
      OR v_tipo_acao IN ('combo_33_44', 'oc33_solo');
    CONTINUE WHEN NOT COALESCE(v_eh_oc33, false);

    -- combo é OPERACIONAL só no Caso 2; fallback conservador = completude
    IF (v_tool = 'lancar_combo_33_44' OR v_tipo_acao = 'combo_33_44') AND v_caso = '2' THEN
      v_natureza := 'operacional';
      v_bloqueada := (v_dossie -> 'romaneio' ->> 'presente') IS DISTINCT FROM 'true';
      v_faltando_todo := CASE WHEN v_bloqueada
                              THEN ARRAY['romaneio de coleta assinado']
                              ELSE ARRAY[]::text[] END;
    ELSE
      v_natureza := 'completude';
      v_bloqueada := NOT v_completo;
      v_faltando_todo := v_faltando;
    END IF;

    UPDATE public.todos
    SET proposta_payload = jsonb_set(
          proposta_payload,
          '{meta,gate_oc33}',
          jsonb_build_object('natureza', v_natureza, 'bloqueada', v_bloqueada,
                             'faltando', to_jsonb(v_faltando_todo)),
          true
        )
    WHERE id = t.id;
    v_todos_recarimbados := v_todos_recarimbados + 1;
  END LOOP;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'EvidenciaDossieConfirmadaPeloOperador', 'operator', v_operador_id::text,
    jsonb_build_object(
      'tipo', p_tipo,
      'fonte', v_entrada ->> 'fonte',
      'filename', v_entrada ->> 'filename',
      'message_inbox_id', p_message_inbox_id,
      'dossie_completo', v_completo,
      'faltando', to_jsonb(v_faltando),
      'todos_recarimbados', v_todos_recarimbados
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', p_card_id,
    'tipo', p_tipo,
    'dossie_completo', v_completo,
    'faltando', to_jsonb(v_faltando),
    'todos_recarimbados', v_todos_recarimbados
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.confirmar_evidencia_dossie(uuid, text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirmar_evidencia_dossie(uuid, text, uuid, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.confirmar_evidencia_dossie(uuid, text, uuid, text, text) IS
  'Operador confirma uma evidencia do dossie de extravio parcial (romaneio exige anexo inbound real). Monotonica, fail-closed, recarimba meta.gate_oc33 dos todos ativos. ADR 0023 / ancora NF 632603.';
