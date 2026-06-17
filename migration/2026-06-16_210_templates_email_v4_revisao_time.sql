-- ============================================================================
-- 2026-06-16_210_templates_email_v4_revisao_time
--
-- Aplica a revisão dos templates de email feita pelo time (doc
-- "REVISAO_TEMPLATES_TIME", preenchido por Duilio em 14/06/2026).
--
-- Decisões do Caio (2026-06-16):
--  1. Assinatura "{operadora_nome} Sal Express — Relacionamento" em TODOS os
--     emails de notificação/cobrança (mesmo onde o doc não retipou).
--  2. {empresa} adicionado ao final de TODOS os assuntos (humaniza + ajuda IA).
--     Exceção: templates RESPOSTA_* (assunto "Re: NF {nf}" herda a thread).
--  3. Templates 8 (FALTA_DE_VOLUME_TOTAL) e 9 (EXTRAVIO_TOTAL_PEDIR_ROMANEIO)
--     mantidos separados; texto novo aplicado em cada (o do 8 já remove a parte
--     de "pedir reposição").
--  4. {primeiro_nome}: SEM nome da pessoa → saudação NEUTRA ("Olá,") em vez de
--     forçar o nome da empresa. Implementado no executor (cascata) e aqui na
--     RPC de preview (pra preview == envio).
--
-- skill: supabase-postgres-best-practices
--   * Só UPDATE de dados (templates_email) + CREATE OR REPLACE da RPC preview.
--   * RPC mantém SECURITY DEFINER + SET search_path + STABLE (só lê).
--   * Sem mudança de schema/índice/RLS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CORPOS NOVOS (13 templates com "Texto sugerido" preenchido no doc)
-- ----------------------------------------------------------------------------

-- 1) Recusa Total
UPDATE public.templates_email SET corpo_template = $b$Olá, {primeiro_nome}!

Ao realizarmos a tentativa de entrega referente à NF {nf}, o destinatário recusou receber a carga.

A evidência registrada pelo motorista pode ser acessada por meio do link abaixo: {link_evidencia}

Para que possamos dar continuidade ao atendimento da ocorrência, poderia, por gentileza, nos orientar sobre a tratativa desejada: seguir com a devolução da mercadoria ou realizar uma nova tentativa de entrega?

Informamos ainda que, conforme o período de permanência da carga em nossa unidade, poderão ser aplicadas cobranças de armazenagem.

Obrigado!

{operadora_nome} Sal Express — Relacionamento$b$, updated_at = now()
WHERE id = 'RECUSA_TOTAL';

-- 2) Recusa Parcial
UPDATE public.templates_email SET corpo_template = $b$Olá, {primeiro_nome}!

Ao realizarmos a tentativa de entrega referente à NF {nf}, o destinatário recusou parte da mercadoria.

A evidência registrada pelo motorista pode ser acessada por meio do seguinte link: {link_evidencia}

Para que possamos dar continuidade ao processo, poderia, por gentileza, nos orientar se podemos prosseguir com a devolução dos volumes recusados?

Informamos ainda que poderão ser aplicadas cobranças de armazenagem, conforme o período de permanência da carga em nossa unidade.

{operadora_nome} Sal Express — Relacionamento$b$, updated_at = now()
WHERE id = 'RECUSA_PARCIAL';

-- 3) Recusa após entrega parcial
UPDATE public.templates_email SET corpo_template = $b$Olá {primeiro_nome},

Identificamos que a NF {nf} foi entregue parcialmente, com recusa de parte da carga no destino.

A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}

Como o cliente já realizou a recusa dos demais volumes, devemos seguir com a devolução dos mesmos?

Ficamos no aguardo de sua orientação. Obrigado!

{operadora_nome} Sal Express — Relacionamento$b$, updated_at = now()
WHERE id = 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME';

-- 4) Problemas com endereço
UPDATE public.templates_email SET corpo_template = $b$Olá {primeiro_nome},

Ao realizarmos a tentativa de entrega referente à NF {nf}, não foi possível localizar o endereço informado. Poderia confirmar o endereço, se possível, encaminhando o link no maps, contato ativo e referência?

Segue evidência registrada pelo motorista, que pode ser acessada através do link: {link_evidencia}

Caso necessário, solicitamos também o envio de uma CCe.

Ficamos no aguardo de sua orientação para prosseguirmos com a reentrega o quanto antes.

{operadora_nome} Sal Express — Relacionamento$b$, updated_at = now()
WHERE id = 'PROBLEMAS_COM_ENDERECO';

-- 5) Entregue com falta de volumes (pedir romaneio)
UPDATE public.templates_email SET corpo_template = $b$Olá {primeiro_nome},

Realizamos a entrega da NF {nf} no destino final com falta de {n_volumes_falta} volume(s).

A evidência registrada pode ser acessada no link: {link_evidencia}

Para darmos sequência ao processo de ressarcimento dos volumes faltantes, gentileza encaminhar o romaneio de coleta assinado da NF e a descrição/valor dos itens faltantes.

Assim que recebermos, abrimos o processo de ressarcimento internamente.

Ficamos no aguardo. Obrigado!

{operadora_nome} Sal Express — Relacionamento$b$, updated_at = now()
WHERE id = 'ENTREGUE_COM_FALTA_PEDIR_ROMANEIO';

-- 6) Extravio parcial (sem quantidade exata)
UPDATE public.templates_email SET corpo_template = $b$Olá {primeiro_nome},

Gostaria de informar o extravio de {n_volumes_falta} volume(s) referente(s) à NF {nf}.

Podemos seguir com a entrega parcial ou devemos seguir com a devolução?

Ficamos no aguardo de sua orientação para prosseguirmos. Obrigado!

{operadora_nome} Sal Express — Relacionamento$b$, updated_at = now()
WHERE id = 'FALTA_DE_VOLUME';

-- 7) Extravio parcial (quantidade exata — ex: 3 de 10)
UPDATE public.templates_email SET corpo_template = $b$Olá {primeiro_nome},

Identificamos que durante o transporte da NF {nf} houve extravio de {n_volumes_falta} de {qtde_volumes} volumes. Localizamos o restante.

Para prosseguirmos, poderia nos orientar: (a) seguir com a entrega parcial dos volumes localizados, OU (b) realizar a devolução total?

Caso localizado em até 5 dias com autorização para entrega parcial, seguiremos com os volumes localizados ao cliente.

Atenciosamente, {operadora_nome} Sal Express — Relacionamento$b$, updated_at = now()
WHERE id = 'EXTRAVIO_PARCIAL';

-- 8) Extravio total (busca concluída) — sem pedir reposição (decisão Duilio/Caio)
UPDATE public.templates_email SET corpo_template = $b$Olá {primeiro_nome},

Gostaríamos de informar o extravio total referente à NF {nf}. As buscas internas já foram concluídas e os volumes não foram localizados.

Caso os volumes sejam localizados posteriormente, seguiremos automaticamente com a devolução dos mesmos, de forma isenta.

Poderiam, por favor, nos enviar o romaneio de coleta assinado da NF?

{operadora_nome} Sal Express — Relacionamento$b$, updated_at = now()
WHERE id = 'FALTA_DE_VOLUME_TOTAL';

-- 9) Extravio total (pedir romaneio para indenização)
UPDATE public.templates_email SET corpo_template = $b$Olá {primeiro_nome},

Lamentamos informar que todos os volumes da NF {nf} foram extraviados durante o transporte e não foram localizados dentro do prazo padrão de busca.

Para darmos continuidade ao processo de indenização, solicitamos o envio do romaneio assinado.

Ficamos à disposição para esclarecimentos.

Atenciosamente, {operadora_nome} Sal Express — Relacionamento$b$, updated_at = now()
WHERE id = 'EXTRAVIO_TOTAL_PEDIR_ROMANEIO';

-- 11) Cobrança lembrete — 4 dias
UPDATE public.templates_email SET corpo_template = $b$Olá {primeiro_nome},

Conforme comunicado anterior, registramos uma ocorrência na tentativa de entrega referente à NF {nf}.

A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}

Teríamos retorno de como proceder?

Ressaltamos que poderão ser aplicadas cobranças de armazenagem.

{operadora_nome} Sal Express — Relacionamento$b$, updated_at = now()
WHERE id = 'COBRANCA_LEMBRETE_4DIAS';

-- 13) Cliente autorizou reentrega (resposta curta, na mesma thread)
UPDATE public.templates_email SET corpo_template = $b$Notado {saudacao}, iremos seguir com a reentrega o mais rápido possível. Obrigado.$b$, updated_at = now()
WHERE id = 'RESPOSTA_AUTORIZA_REENTREGA';

-- 14) Cliente autorizou devolução
UPDATE public.templates_email SET corpo_template = $b$Notado {saudacao}, iremos seguir com a devolução, em até 7 dias você receberá em seu estabelecimento. Obrigado!$b$, updated_at = now()
WHERE id = 'RESPOSTA_AUTORIZA_DEVOLUCAO';

-- 15) Cliente autorizou entrega parcial
UPDATE public.templates_email SET corpo_template = $b$Notado {saudacao}, iremos seguir com a entrega parcial conforme combinado.

Poderia nos encaminhar o romaneio de coleta para que adicionemos ao processo?

Obrigado$b$, updated_at = now()
WHERE id = 'RESPOSTA_AUTORIZA_ENTREGA_PARCIAL';

-- ----------------------------------------------------------------------------
-- 2. ASSUNTOS: adiciona " — {empresa}" no fim (decisão 2). RESPOSTA_* ficam fora.
-- ----------------------------------------------------------------------------
UPDATE public.templates_email SET assunto = 'Recusa Total — NF {nf} — {empresa}', updated_at = now() WHERE id = 'RECUSA_TOTAL';
UPDATE public.templates_email SET assunto = 'Recusa Parcial — NF {nf} — {empresa}', updated_at = now() WHERE id = 'RECUSA_PARCIAL';
UPDATE public.templates_email SET assunto = 'Recusa após entrega parcial — NF {nf} — {empresa}', updated_at = now() WHERE id = 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME';
UPDATE public.templates_email SET assunto = 'Insucesso na entrega — NF {nf} — {empresa}', updated_at = now() WHERE id = 'PROBLEMAS_COM_ENDERECO';
UPDATE public.templates_email SET assunto = 'Entrega parcial concluída — NF {nf} — {empresa}', updated_at = now() WHERE id = 'ENTREGUE_COM_FALTA_PEDIR_ROMANEIO';
UPDATE public.templates_email SET assunto = 'Extravio Parcial — NF {nf} — {empresa}', updated_at = now() WHERE id = 'FALTA_DE_VOLUME';
UPDATE public.templates_email SET assunto = 'Extravio parcial — NF {nf} — {empresa}', updated_at = now() WHERE id = 'EXTRAVIO_PARCIAL';
UPDATE public.templates_email SET assunto = 'Extravio Total — NF {nf} — {empresa}', updated_at = now() WHERE id = 'FALTA_DE_VOLUME_TOTAL';
UPDATE public.templates_email SET assunto = 'Extravio total — NF {nf} — {empresa}', updated_at = now() WHERE id = 'EXTRAVIO_TOTAL_PEDIR_ROMANEIO';
UPDATE public.templates_email SET assunto = 'Aviso Importante: Extravio Total NF {nf} — {empresa}', updated_at = now() WHERE id = 'EXTRAVIO_TOTAL_NOTIFICACAO';
UPDATE public.templates_email SET assunto = 'Aguardando retorno — NF {nf} — {empresa}', updated_at = now() WHERE id = 'COBRANCA_LEMBRETE_4DIAS';
UPDATE public.templates_email SET assunto = 'Aviso de cobrança de armazenagem — NF {nf} — {empresa}', updated_at = now() WHERE id = 'COBRANCA_LEMBRETE_8DIAS';
UPDATE public.templates_email SET assunto = 'Aguardando retorno — NF {nf} — {empresa}', updated_at = now() WHERE id = 'COBRANCA_LEMBRETE';

-- ----------------------------------------------------------------------------
-- 3. RPC preview_email_todo: alinha {primeiro_nome} ao executor (cascata nome
--    da pessoa) + saudação neutra quando não há nome. Resto idêntico à mig 186.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_email_todo(
  p_todo_id uuid,
  p_template_id_override text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
  v_agent jsonb;
  v_aviso jsonb;
  v_template_sugerido_ia text;
  v_qtd_volumes_extraviados text;
  v_qtd_volumes_nf text;
  v_primeiro_nome text;
  v_nome_cliente text;
  v_operadora_nome text;
  v_cnpj_pagador text;
  v_seg text;
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

  -- {primeiro_nome}: nome da PESSOA contato (alinhado com executor 2026-06-16).
  -- Cascata: (1) contatos_cliente.nome_pessoa do email destino; (2) derivado do
  -- email (allyson.ferreira@ -> Allyson), exceto prefixos genéricos; (3) vazio
  -- (saudação neutra). NÃO cai mais no nome da empresa.
  v_primeiro_nome := '';
  IF v_email_destino IS NOT NULL AND v_email_destino <> '' THEN
    SELECT NULLIF(TRIM(SPLIT_PART(c.nome_pessoa, ' ', 1)), '')
    INTO v_primeiro_nome
    FROM public.contatos_cliente c
    WHERE c.tipo = 'email'
      AND c.identificador = LOWER(TRIM(v_email_destino))
      AND c.nome_pessoa IS NOT NULL
    ORDER BY c.ordem NULLS LAST
    LIMIT 1;

    IF v_primeiro_nome IS NULL OR v_primeiro_nome = '' THEN
      v_seg := (regexp_split_to_array(SPLIT_PART(LOWER(TRIM(v_email_destino)), '@', 1), '[._-]'))[1];
      IF LENGTH(v_seg) >= 3 AND v_seg NOT IN (
        'sac','contato','atendimento','logistica','comercial','ocorrencias',
        'noreply','compras','financeiro','rma','transporte','expedicao',
        'expedicaobh','central'
      ) THEN
        v_primeiro_nome := INITCAP(v_seg);
      ELSE
        v_primeiro_nome := '';
      END IF;
    END IF;
  END IF;
  v_primeiro_nome := COALESCE(v_primeiro_nome, '');

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

  -- Saudação neutra quando não há nome da pessoa (espelha o executor).
  IF v_primeiro_nome = '' THEN
    v_corpo := regexp_replace(v_corpo, '^Olá,\s*!', 'Olá!');
    v_corpo := regexp_replace(v_corpo, '^Olá\s+,', 'Olá,');
    v_corpo := regexp_replace(v_corpo, '^Prezado\(a\)\s+,', 'Prezados,');
  END IF;

  v_ids_aplicaveis := CASE v_card.cod_ultima_ocorrencia
    WHEN 10 THEN ARRAY['RECUSA_TOTAL', 'COBRANCA_LEMBRETE']
    WHEN 11 THEN ARRAY['PROBLEMAS_COM_ENDERECO', 'COBRANCA_LEMBRETE']
    WHEN 35 THEN ARRAY['RECUSA_PARCIAL', 'COBRANCA_LEMBRETE']
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
$function$;
