-- ============================================================================
-- 2026-06-25_267_recusa_extravio_oc19_so_notifica_nao_devolve
--
-- CONTEXTO (Caio 2026-06-25, NF 179799):
--   A interpretação "recusa originada de extravio" (mig 254, NF 148558) estava
--   CORRETA, mas o contexto/ação sugerido tratava oc=19 igual a oc=10/35 —
--   perguntando "devolução x nova entrega". Isso está ERRADO pra oc=19.
--
--   Diferença essencial oc=19 x oc=35 (regra Caio):
--     - oc=19 (ENTREGUE COM falta): a entrega foi feita; o que faltou foi
--       EXTRAVIADO (perdido). NÃO existe nada físico a devolver. A ação é só
--       NOTIFICAR o cliente + pedir romaneio + descrição + valor pra abrir o
--       ressarcimento (extravio parcial → futuro oc=33). NUNCA pergunta destino.
--     - oc=35 (RECUSA): o cliente recusou; EXISTE volume físico parado no destino
--       → aí sim pergunta devolução x nova entrega (template combinado).
--
--   Correção de código: agente-sugere-ocs-padrao agora decide via função pura
--   montarSugestaoRecusaPorExtravio (_shared/recusa-por-extravio.ts) — oc=19
--   mantém o template ENTREGUE_COM_FALTA_PEDIR_ROMANEIO (só notifica), oc=10/35
--   seguem com RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR.
--
--   Esta migration alinha o BANCO ao código:
--     1) Descrição do template RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR: oc 10/35
--        (não mais 10/19/35) — só recusa com volume físico a devolver.
--     2) preview_email_todo: dropdown da oc=19 NÃO oferece mais
--        RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR (oc=19 não devolve nada) + default da
--        oc=19 passa a ser ENTREGUE_COM_FALTA_PEDIR_ROMANEIO (antes caía no
--        ELSE COBRANCA_LEMBRETE quando não havia sugestão da IA).
--
-- skill: supabase-postgres-best-practices
--   * UPDATE pontual de 1 linha em templates_email (sem índice novo).
--   * CREATE OR REPLACE de preview_email_todo: corpo IDÊNTICO à mig 254
--     (capturado de lá), ÚNICAS mudanças = bloco v_ids_aplicaveis (oc=19) e o
--     CASE de default v_template_id (oc=19). Preserva SECURITY DEFINER +
--     SET search_path = public + saudação resolver_primeiro_nome_email (mig 253).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Descrição do template combinado: agora oc 10/35 (não 19 — 19 não devolve).
--    Corpo do template segue idêntico (continua válido pra recusa com volume).
-- ----------------------------------------------------------------------------
UPDATE public.templates_email
SET descricao = 'Recusa no destino (oc 10/35) causada por extravio anterior (oc 6/9/16) ainda não notificado ao cliente. EXISTE volume físico a devolver: notifica a falta, pergunta devolução x nova entrega E pede romaneio + descrição + valor dos itens pra abrir ressarcimento (combo 33+44). oc=19 NÃO usa este template (entregue com falta = extraviado, nada a devolver → ENTREGUE_COM_FALTA_PEDIR_ROMANEIO).'
WHERE id = 'RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR';

-- ----------------------------------------------------------------------------
-- 2. preview_email_todo: dropdown/default da oc=19 sem o template de devolução.
--    (Definição idêntica à mig 254; ÚNICAS mudanças marcadas com "mig 267".)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_email_todo(p_todo_id uuid, p_template_id_override text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_todo record;
  v_card record;
  v_template record;
  v_template_id text;
  v_assunto text;
  v_corpo text;
  v_email_destino text;
  v_destinatarios jsonb;
  v_num_dest int;
  v_fallback text;
  v_agent jsonb;
  v_aviso jsonb;
  v_template_sugerido_ia text;
  v_qtd_volumes_extraviados text;
  v_qtd_volumes_nf text;
  v_primeiro_nome text;
  v_nome_cliente text;
  v_operadora_nome text;
  v_cnpj_pagador text;
  v_ids_aplicaveis text[];
  v_templates_disponiveis jsonb;
BEGIN
  SELECT id, card_id, proposta_payload, status
  INTO v_todo
  FROM public.todos WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id;
  END IF;

  SELECT id, nf, empresa_cliente, agent_state, responsavel_relacionamento,
         cod_ultima_ocorrencia, aviso_alteracao_oc
  INTO v_card
  FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  v_aviso := COALESCE(v_card.aviso_alteracao_oc, '{}'::jsonb);
  v_template_sugerido_ia := v_aviso->>'template_email_sugerido';
  v_qtd_volumes_extraviados := v_aviso->>'qtd_volumes_extraviados';
  v_qtd_volumes_nf := v_aviso->>'qtd_volumes_nf';

  v_template_id := COALESCE(
    p_template_id_override,
    v_template_sugerido_ia,
    v_todo.proposta_payload->'args'->>'template_id'
  );

  IF v_template_id IS NULL THEN
    v_template_id := CASE v_card.cod_ultima_ocorrencia
      WHEN 10 THEN 'RECUSA_TOTAL'
      WHEN 11 THEN 'PROBLEMAS_COM_ENDERECO'
      WHEN 19 THEN 'ENTREGUE_COM_FALTA_PEDIR_ROMANEIO' -- mig 267: oc=19 default próprio (era ELSE COBRANCA_LEMBRETE)
      WHEN 35 THEN 'RECUSA_PARCIAL'
      WHEN 49 THEN 'FALTA_DE_VOLUME'
      ELSE 'COBRANCA_LEMBRETE'
    END;
  END IF;

  SELECT id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo
  INTO v_template
  FROM public.templates_email WHERE id = v_template_id;

  IF v_template.id IS NULL THEN
    RAISE EXCEPTION 'Template % não encontrado', v_template_id;
  END IF;

  v_destinatarios := v_todo.proposta_payload->'args'->'extras'->'email_destinatarios';
  IF v_destinatarios IS NOT NULL AND jsonb_typeof(v_destinatarios) = 'array'
     AND jsonb_array_length(v_destinatarios) > 0 THEN
    v_email_destino := v_destinatarios->>0;
  ELSE
    v_email_destino := v_todo.proposta_payload->'args'->>'email_destino';
  END IF;

  -- Nº de destinatários (TO+CC) decide a saudação genérica (Prezado(a)/Pessoal).
  v_num_dest := CASE
    WHEN v_destinatarios IS NOT NULL AND jsonb_typeof(v_destinatarios) = 'array'
      THEN GREATEST(jsonb_array_length(v_destinatarios), 1)
    ELSE 1
  END;

  IF v_email_destino IS NULL OR v_email_destino = '' THEN
    v_agent := COALESCE(v_card.agent_state, '{}'::jsonb);
    v_cnpj_pagador := v_agent->>'cnpj_pagador';
    IF v_cnpj_pagador IS NOT NULL AND v_cnpj_pagador <> '' THEN
      BEGIN
        v_email_destino := public.resolver_email_cobranca_cliente(
          v_cnpj_pagador, 'logistico'
        );
      EXCEPTION WHEN OTHERS THEN
        v_email_destino := NULL;
      END;
    END IF;
  END IF;

  v_agent := COALESCE(v_card.agent_state, '{}'::jsonb);
  v_nome_cliente := COALESCE(v_card.empresa_cliente, '');
  v_operadora_nome := COALESCE(v_card.responsavel_relacionamento, 'Sal Express');

  -- {primeiro_nome}: fonte única (mig 225). Só nome de PESSOA; nunca empresa/
  -- rótulo genérico. Vazio => saudação Prezado(a)/Pessoal mais abaixo.
  v_primeiro_nome := public.resolver_primeiro_nome_email(v_email_destino, v_nome_cliente);

  v_assunto := v_template.assunto;
  v_corpo := v_template.corpo_template;

  v_assunto := REPLACE(v_assunto, '{nome_cliente}', v_nome_cliente);
  v_assunto := REPLACE(v_assunto, '{primeiro_nome}', v_primeiro_nome);
  v_assunto := REPLACE(v_assunto, '{nf}', COALESCE(v_card.nf, ''));
  v_assunto := REPLACE(v_assunto, '{empresa}', v_nome_cliente);
  v_assunto := REPLACE(v_assunto, '{operadora_nome}', v_operadora_nome);
  v_assunto := REPLACE(v_assunto, '{cidade_destino}', COALESCE(v_agent->>'cidade_destino', ''));
  v_assunto := REPLACE(v_assunto, '{previsao_atual}', COALESCE(v_agent->>'previsao_entrega', ''));
  v_assunto := REPLACE(v_assunto, '{descricao_problema}', COALESCE(v_agent->>'instrucao_ultima_ocorrencia', ''));

  v_corpo := REPLACE(v_corpo, '{nome_cliente}', v_nome_cliente);
  v_corpo := REPLACE(v_corpo, '{primeiro_nome}', v_primeiro_nome);
  v_corpo := REPLACE(v_corpo, '{saudacao}', v_primeiro_nome);
  v_corpo := REPLACE(v_corpo, '{nf}', COALESCE(v_card.nf, ''));
  v_corpo := REPLACE(v_corpo, '{empresa}', v_nome_cliente);
  v_corpo := REPLACE(v_corpo, '{operadora_nome}', v_operadora_nome);
  v_corpo := REPLACE(v_corpo, '{cidade_destino}', COALESCE(v_agent->>'cidade_destino', ''));
  v_corpo := REPLACE(v_corpo, '{previsao_atual}', COALESCE(v_agent->>'previsao_entrega', ''));
  v_corpo := REPLACE(v_corpo, '{descricao_problema}', COALESCE(v_agent->>'instrucao_ultima_ocorrencia', ''));

  v_assunto := REPLACE(v_assunto, '{n_volumes_falta}', COALESCE(v_qtd_volumes_extraviados, ''));
  v_assunto := REPLACE(v_assunto, '{qtde_volumes}', COALESCE(v_qtd_volumes_nf, ''));
  v_corpo := REPLACE(v_corpo, '{n_volumes_falta}', COALESCE(v_qtd_volumes_extraviados, ''));
  v_corpo := REPLACE(v_corpo, '{qtde_volumes}', COALESCE(v_qtd_volumes_nf, ''));

  -- Sem nome da pessoa => saudação genérica:
  --   1 destinatário  -> "Prezado(a),"
  --   > 1 destinatário -> "Pessoal,"
  -- (espelhado no executor e na edge cobrar-cliente-aguardando — mig 225).
  IF v_primeiro_nome = '' THEN
    v_fallback := CASE WHEN v_num_dest > 1 THEN 'Pessoal' ELSE 'Prezado(a)' END;
    v_corpo := regexp_replace(v_corpo, '^Olá,\s*!', v_fallback || ',');
    v_corpo := regexp_replace(v_corpo, '^Olá\s+,', v_fallback || ',');
    v_corpo := regexp_replace(v_corpo, '^Prezado\(a\)\s+,', v_fallback || ',');
    v_corpo := regexp_replace(v_corpo, '^Notado\s+,', 'Notado,');
  END IF;

  v_ids_aplicaveis := CASE v_card.cod_ultima_ocorrencia
    WHEN 10 THEN ARRAY['RECUSA_TOTAL','RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR','COBRANCA_LEMBRETE']
    WHEN 11 THEN ARRAY['PROBLEMAS_COM_ENDERECO', 'COBRANCA_LEMBRETE']
    -- mig 267: oc=19 (entregue com falta = extraviado) NÃO oferece o template de
    -- devolução — não há nada físico a devolver, só notifica + pede romaneio.
    WHEN 19 THEN ARRAY['ENTREGUE_COM_FALTA_PEDIR_ROMANEIO','COBRANCA_LEMBRETE']
    WHEN 35 THEN ARRAY['RECUSA_PARCIAL','RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR','COBRANCA_LEMBRETE']
    WHEN 49 THEN ARRAY['EXTRAVIO_PARCIAL','EXTRAVIO_TOTAL_PEDIR_ROMANEIO',
                       'RECUSA_TOTAL','RECUSA_PARCIAL','PROBLEMAS_COM_ENDERECO',
                       'FALTA_DE_VOLUME','ENDERECO_INCORRETO','COBRANCA_LEMBRETE']
    ELSE ARRAY['COBRANCA_LEMBRETE']
  END;

  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'nome', nome,
    'descricao', descricao
  ) ORDER BY
    CASE WHEN id = v_template_id THEN 0 ELSE 1 END,
    id
  )
  INTO v_templates_disponiveis
  FROM public.templates_email
  WHERE id = ANY(v_ids_aplicaveis) AND ativo = true;

  RETURN jsonb_build_object(
    'todo_id', p_todo_id,
    'card_id', v_card.id,
    'nf', v_card.nf,
    'codigo_ssw_proposta', (v_todo.proposta_payload->'args'->>'codigo_ssw')::int,
    'cod_ultima_ocorrencia_card', v_card.cod_ultima_ocorrencia,
    'email_destino', v_email_destino,
    'template_atual', jsonb_build_object(
      'id', v_template.id,
      'nome', v_template.nome,
      'descricao', v_template.descricao,
      'assunto_renderizado', v_assunto,
      'corpo_renderizado', v_corpo,
      'usa_link_evidencia', v_template.corpo_template LIKE '%{link_evidencia}%'
    ),
    'templates_disponiveis', COALESCE(v_templates_disponiveis, '[]'::jsonb),
    'template_sugerido_ia', v_template_sugerido_ia
  );
END;
$function$
;
