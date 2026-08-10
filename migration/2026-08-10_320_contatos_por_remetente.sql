-- ============================================================================
-- 2026-08-10_320 — Contatos de cliente POR REMETENTE (estrutura, sem seed).
--
-- Caso AGV (segmento Operador Logístico / onboarding MARIA, plano aprovado
-- 10/08): o pagador AGV tem um contato interno DIFERENTE por remetente da NF
-- (NF da Abbot → fulano@agv; NF da Virbac → ciclano@agv). Hoje a resolução de
-- destinatário é só por CNPJ pagador + tipo_uso.
--
-- Desenho (zero regressão POR CONSTRUÇÃO):
--   * contatos_cliente.cnpj_remetente NULL = contato geral (todo o legado).
--   * resolver_email_cobranca_cliente ganha 3º parâmetro DEFAULT NULL:
--       - remetente informado → prefere linha específica; senão gerais.
--       - remetente NULL → SÓ gerais (contato da Abbot nunca vira genérico).
--     Sem linhas específicas cadastradas, resultado idêntico ao de hoje para
--     TODAS as chamadas (asserts no fim provam).
--   * preview_email_todo (cópia da versão vigente, mig 267) passa o
--     cnpj_remetente CRU do agent_state no fallback.
-- Seed dos contatos AGV: migration própria quando a planilha do Caio chegar.
-- ============================================================================

BEGIN;

-- 1. Coluna + índice parcial
ALTER TABLE public.contatos_cliente
  ADD COLUMN IF NOT EXISTS cnpj_remetente text;

COMMENT ON COLUMN public.contatos_cliente.cnpj_remetente IS
  'Só dígitos. Preenchido = contato específico deste remetente (caso AGV). NULL = contato geral do cliente (comportamento clássico).';

CREATE INDEX IF NOT EXISTS idx_contatos_cliente_doc_remetente
  ON public.contatos_cliente (documento_cliente, cnpj_remetente)
  WHERE cnpj_remetente IS NOT NULL;

-- 2. Resolver com a dimensão do remetente (assinatura antiga continua válida)
DROP FUNCTION IF EXISTS public.resolver_email_cobranca_cliente(text, text);
CREATE OR REPLACE FUNCTION public.resolver_email_cobranca_cliente(
  p_documento_cliente text,
  p_tipo_uso text DEFAULT 'cobranca',
  p_cnpj_remetente text DEFAULT NULL
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH rem AS (
    SELECT NULLIF(regexp_replace(COALESCE(p_cnpj_remetente, ''), '\D', '', 'g'), '') AS r
  )
  SELECT c.identificador
  FROM public.contatos_cliente c, rem
  WHERE c.documento_cliente = p_documento_cliente
    AND c.tipo = 'email'
    AND c.ativo = true
    AND c.tipo_uso IN (p_tipo_uso, 'geral')
    AND (c.cnpj_remetente IS NULL OR c.cnpj_remetente = rem.r)
  ORDER BY
    CASE WHEN c.cnpj_remetente IS NOT NULL THEN 0 ELSE 1 END,  -- específica vence
    CASE WHEN c.tipo_uso = p_tipo_uso THEN 0 ELSE 1 END,
    c.ordem ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.resolver_email_cobranca_cliente(text, text, text)
  TO service_role, authenticated;

-- 3. preview_email_todo — versão vigente (mig 267) + remetente no fallback
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
        -- mig 320: passa o cnpj_remetente CRU (sem colapso null->pagador) —
        -- clientes com contato por remetente (AGV) resolvem a pessoa certa;
        -- NULL/sem cadastro específico cai nas linhas gerais (comportamento antigo).
        v_email_destino := public.resolver_email_cobranca_cliente(
          v_cnpj_pagador, 'logistico', v_agent->>'cnpj_remetente'
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

-- 4. ASSERTS de zero-regressão (abortam a transação se falharem)
DO $do$
DECLARE
  v_doc text := '99999999000199';
  v_geral text;
  v_com_rem text;
  v_sem_rem text;
BEGIN
  -- fixture temporária
  INSERT INTO public.clientes (cnpj_cpf, nome, ativo)
  VALUES (v_doc, '__TESTE_MIG320__', true)
  ON CONFLICT (cnpj_cpf) DO NOTHING;
  INSERT INTO public.contatos_cliente
    (documento_cliente, tipo, identificador, ordem, tipo_uso, nome_pessoa, ativo, operador_responsavel_id, cnpj_remetente)
  VALUES
    (v_doc, 'email', 'geral@teste.mig320', 1, 'logistico', 'Geral', true,
      (SELECT id FROM public.operadores WHERE nome='MARIA'), NULL),
    (v_doc, 'email', 'fulano@teste.mig320', 1, 'logistico', 'Fulano', true,
      (SELECT id FROM public.operadores WHERE nome='MARIA'), '11111111000111');

  v_geral   := public.resolver_email_cobranca_cliente(v_doc, 'logistico');
  v_com_rem := public.resolver_email_cobranca_cliente(v_doc, 'logistico', '11.111.111/0001-11');
  v_sem_rem := public.resolver_email_cobranca_cliente(v_doc, 'logistico', '22222222000122');

  IF v_geral IS DISTINCT FROM 'geral@teste.mig320' THEN
    RAISE EXCEPTION 'MIG320 A1: sem remetente TEM que ignorar linha específica (veio %)', v_geral;
  END IF;
  IF v_com_rem IS DISTINCT FROM 'fulano@teste.mig320' THEN
    RAISE EXCEPTION 'MIG320 A2: remetente casado TEM que preferir a específica (veio %)', v_com_rem;
  END IF;
  IF v_sem_rem IS DISTINCT FROM 'geral@teste.mig320' THEN
    RAISE EXCEPTION 'MIG320 A3: remetente desconhecido cai na geral (veio %)', v_sem_rem;
  END IF;

  -- limpa a fixture
  DELETE FROM public.contatos_cliente WHERE documento_cliente = v_doc;
  DELETE FROM public.clientes WHERE cnpj_cpf = v_doc;
END;
$do$;

COMMIT;
