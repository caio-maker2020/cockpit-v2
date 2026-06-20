-- ============================================================================
-- 2026-06-20_225_saudacao_email_nome_pessoa_robusto
--
-- PROBLEMA (Caio 2026-06-20, print NF 775459):
--   O e-mail saía "Olá, F!" — o "F" veio de contatos_cliente.nome_pessoa =
--   "F E F DISTRIBUIDORA DE PRODUTO A2" (nome da EMPRESA salvo no campo de
--   pessoa). A cascata de {primeiro_nome} fazia SPLIT_PART(nome_pessoa,' ',1)
--   e devolvia o primeiro token do nome da empresa.
--
--   Os dados de contatos_cliente.nome_pessoa são um MIX:
--     - nomes reais de pessoa (Lucas, Paulo, Fernando, Ana Paula...)  -> usar
--     - nomes de EMPRESA (UNIÃO QUIMICA, CICLO CAIRU LTDA, F E F...)   -> NÃO usar
--     - rótulos genéricos (SAC[56x], Central, Pendencia, Transporte..) -> NÃO usar
--
-- DECISÃO (Caio 2026-06-20):
--   1. Só tratar nome_pessoa como nome de PESSOA quando ele realmente parece
--      pessoa (não empresa / não rótulo genérico / 1º token alfabético >= 2).
--   2. Derivar nome do e-mail SÓ quando há separador (formato nome.sobrenome),
--      pra não inventar "Dbarcelos" de dbarcelos@...
--   3. Sem nome confiável => saudação:
--        - "Prezado(a)," quando há 1 destinatário
--        - "Pessoal,"    quando há > 1 destinatário
--      (substitui o antigo fallback neutro "Olá,").
--
--   Fonte ÚNICA da resolução do nome: função public.resolver_primeiro_nome_email,
--   consumida pela RPC preview_email_todo (preview do modal), pelo executor
--   (envio real) e pela edge cobrar-cliente-aguardando.
--
-- skill: supabase-postgres-best-practices
--   * 2 funções novas (1 IMMUTABLE pura, 1 STABLE que lê 1 tabela) + CREATE OR
--     REPLACE da RPC de preview. Sem mudança de schema/RLS/índice.
--   * Todas com SET search_path. resolver NÃO é SECURITY DEFINER: os callers
--     (preview = DEFINER; executor/cobranca = service_role) já enxergam as
--     linhas; manter INVOKER reduz superfície.
--   * contatos_cliente tem só 510 linhas e o lookup roda 1x/e-mail — seq scan
--     é irrelevante, não cria índice novo (write overhead à toa).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Predicado puro: nome_pessoa é utilizável como nome de PESSOA?
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._nome_pessoa_usavel(p_nome text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  WITH t AS (
    SELECT
      btrim(p_nome)                                            AS nome,
      lower(btrim(p_nome))                                     AS nome_l,
      lower(btrim(split_part(btrim(p_nome), ' ', 1)))          AS tok1
  )
  SELECT CASE
    WHEN nome IS NULL OR nome = '' THEN false
    -- 1º token precisa ser alfabético (com acentos) e ter >= 2 letras.
    -- Mata "F", "-", "A2", "R2", iniciais soltas.
    WHEN tok1 !~ '^[a-zà-ÿ]{2,}$' THEN false
    -- 1º token precisa ter vogal. Mata siglas só-consoante de empresa
    -- (DPK, DRM, DWD, VCH, LDI, SP, DMDC...). Todo nome PT-BR tem vogal.
    WHEN tok1 !~ '[aeiouáàâãäéèêëíìîïóòôõöúùûü]' THEN false
    -- 1º token é rótulo genérico de setor / caixa compartilhada.
    WHEN tok1 = ANY (ARRAY[
      'sac','central','pendencia','pendência','transporte','transportes',
      'expedicao','expedição','expedicaobh','compras','financeiro','financeirobh',
      'fiscal','comercial','logistica','logística','logistico','atendimento',
      'recebimento','faturamento','vendas','suporte','adm','administrativo',
      'administracao','administração','nfe','cobranca','cobrança','contato',
      'ocorrencias','ocorrências','recepcao','recepção','portaria','almoxarifado',
      'estoque','deposito','depósito','gerencia','gerência','diretoria',
      'operacional','operacao','operação','qualidade','servico','serviço',
      'servicos','serviços','noreply','geral','matriz','filial','teste','none'
    ]) THEN false
    -- Sufixos de razão social (precedidos de espaço/ponto/barra/traço).
    WHEN nome_l ~ '[ ./-](ltda|eireli|epp|mei|me|cia)\.?( |$)' THEN false
    -- "... S/A" | "... S A" | "... S.A." no fim (companhia aberta).
    WHEN nome_l ~ 's\.?\s*/?\s*a\.?\s*$' THEN false
    -- Tokens longos de entidade (prefixo) em qualquer posição. Prefixo cobre
    -- plural/flexão ("cosmetic"->cosmetics, "importa"->importadora).
    WHEN nome_l ~ '(^|[^a-zà-ÿ])(distrib|comerc|industr|qu[ií]mic|farmac|pharma|laborat|atacad|importa|exporta|hospit|cosmetic|automotiv|representac|repres|biciclet|moto|suprimento|equipament|materiais|embalagens|biotech|servic)' THEN false
    -- Abreviações de razão social como token inteiro (entre limites).
    WHEN nome_l ~ '(^|[^a-zà-ÿ])(com|dist|distr|ind|imp|exp|mat|rep|med|prod|cosm|hosp|hospt|bike|peca|peça|pecas|peças|auto|safety|sports?|group|nutri)([^a-zà-ÿ]|$)' THEN false
    ELSE true
  END
  FROM t;
$$;

COMMENT ON FUNCTION public._nome_pessoa_usavel(text) IS
  'true quando o texto parece nome de PESSOA (não empresa/rótulo genérico). '
  'Usado por resolver_primeiro_nome_email. Mig 225.';

-- ----------------------------------------------------------------------------
-- 2. Resolver o {primeiro_nome} a partir do e-mail destino (fonte única).
--    Cascata: (1) contatos_cliente.nome_pessoa utilizável (1º token);
--             (2) derivado do e-mail SÓ se houver separador nome.sobrenome;
--             (3) '' (caller decide Prezado(a)/Pessoal).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolver_primeiro_nome_email(
  p_email   text,
  p_empresa text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_first text;
  v_local text;
  v_tok   text;
BEGIN
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN '';
  END IF;

  -- Passo 1: nome cadastrado da pessoa (descarta empresa/genérico e o caso em
  -- que o nome_pessoa é literalmente o nome da empresa do card).
  SELECT initcap(split_part(btrim(c.nome_pessoa), ' ', 1))
  INTO v_first
  FROM public.contatos_cliente c
  WHERE c.tipo = 'email'
    AND c.identificador = lower(btrim(p_email))
    AND c.nome_pessoa IS NOT NULL
    AND btrim(c.nome_pessoa) <> ''
    AND public._nome_pessoa_usavel(c.nome_pessoa)
    AND lower(btrim(c.nome_pessoa)) <> lower(btrim(COALESCE(p_empresa, '')))
  ORDER BY c.ordem NULLS LAST, c.id
  LIMIT 1;

  IF v_first IS NOT NULL AND v_first <> '' THEN
    RETURN v_first;
  END IF;

  -- Passo 2: deriva do e-mail SÓ quando há separador (nome.sobrenome@...).
  -- Sem separador (dbarcelos@) é arriscado (inicial+sobrenome) -> não deriva.
  v_local := split_part(lower(btrim(p_email)), '@', 1);
  IF v_local ~ '[._+-]' THEN
    v_tok := (regexp_split_to_array(v_local, '[._+-]'))[1];
    IF v_tok ~ '^[a-zà-ÿ]{3,}$'
       AND v_tok <> ALL (ARRAY[
         'sac','contato','atendimento','logistica','comercial','ocorrencias',
         'noreply','compras','financeiro','rma','transporte','expedicao',
         'expedicaobh','central','pendencia','faturamento','fiscal','nfe',
         'vendas','suporte','recebimento','adm','administrativo','cobranca',
         'qualidade','diretoria','gerencia','recepcao','portaria','estoque'
       ]) THEN
      RETURN initcap(v_tok);
    END IF;
  END IF;

  RETURN '';
END;
$$;

COMMENT ON FUNCTION public.resolver_primeiro_nome_email(text, text) IS
  'Resolve {primeiro_nome} do destinatário p/ saudação de e-mail. Fonte única '
  'usada por preview_email_todo, executor e cobrar-cliente-aguardando. Mig 225.';

-- ----------------------------------------------------------------------------
-- 3. RPC preview_email_todo: usa o resolver único + saudação Prezado(a)/Pessoal
--    quando não há nome. Substitui também {saudacao} (templates RESPOSTA_*).
--    Resto idêntico à mig 210.
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
