-- ============================================================================
-- Cockpit v2 — RPC preview_email_todo: dados pra modal de edição de email
-- Data: 2026-05-06
--
-- Regra Caio 2026-05-06: ao aprovar todo com email, Larissa precisa ver
-- assunto+corpo renderizados, podendo editar. RPC devolve:
--   - template atual + assunto/corpo já renderizados com vars do card
--   - lista de templates aplicáveis pra oc do card (Caio mapeou:
--       10 → RECUSA_TOTAL + COBRANCA_LEMBRETE
--       11 → PROBLEMAS_COM_ENDERECO + COBRANCA_LEMBRETE
--       35 → RECUSA_PARCIAL + COBRANCA_LEMBRETE
--       49 → FALTA_DE_VOLUME + COBRANCA_LEMBRETE
--       outros → COBRANCA_LEMBRETE)
--   - email destino resolvido (singular ou 1ª do extras.email_destinatarios)
--
-- {link_evidencia} fica como literal no preview — executor gera token só na
-- hora do envio (evita criar token órfão se Larissa cancelar).
--
-- Uso pelo frontend:
--   1. Modal abre → chama preview_email_todo(todo_id) → mostra dados
--   2. Larissa troca template no dropdown → re-chama com p_template_id_override
--   3. Larissa edita assunto/corpo → confirma →
--      aprovar_e_executar(todo_id, {
--        assunto_override, texto_email_customizado, template_id_override
--      })
-- ============================================================================

DROP FUNCTION IF EXISTS public.preview_email_todo(uuid, text);

CREATE OR REPLACE FUNCTION public.preview_email_todo(
  p_todo_id uuid,
  p_template_id_override text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_primeiro_nome text;
  v_nome_cliente text;
  v_operadora_nome text;
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
         cod_ultima_ocorrencia
  INTO v_card
  FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  -- Resolve template: override > template_id da proposta
  v_template_id := COALESCE(
    p_template_id_override,
    v_todo.proposta_payload->'args'->>'template_id'
  );

  -- Pode não ter template_id se proposta foi criada em modo sem_email
  -- (template inativo na criação). Nesses casos, default pra template
  -- aplicável à oc do card.
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

  -- Email destino: extras.email_destinatarios[0] OU args.email_destino
  v_destinatarios := v_todo.proposta_payload->'args'->'extras'->'email_destinatarios';
  IF v_destinatarios IS NOT NULL AND jsonb_typeof(v_destinatarios) = 'array'
     AND jsonb_array_length(v_destinatarios) > 0 THEN
    v_email_destino := v_destinatarios->>0;
  ELSE
    v_email_destino := v_todo.proposta_payload->'args'->>'email_destino';
  END IF;

  -- Vars do card pra render
  v_agent := COALESCE(v_card.agent_state, '{}'::jsonb);
  v_nome_cliente := COALESCE(v_card.empresa_cliente, '');
  v_primeiro_nome := SPLIT_PART(v_nome_cliente, ' ', 1);
  v_operadora_nome := COALESCE(v_card.responsavel_relacionamento, 'Sal Express');

  -- Substitui placeholders. {link_evidencia} fica literal — executor gera
  -- token só na hora do envio.
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

  -- Templates aplicáveis pra oc origem do card (Caio 2026-05-06)
  v_ids_aplicaveis := CASE v_card.cod_ultima_ocorrencia
    WHEN 10 THEN ARRAY['RECUSA_TOTAL', 'COBRANCA_LEMBRETE']
    WHEN 11 THEN ARRAY['PROBLEMAS_COM_ENDERECO', 'COBRANCA_LEMBRETE']
    WHEN 35 THEN ARRAY['RECUSA_PARCIAL', 'COBRANCA_LEMBRETE']
    WHEN 49 THEN ARRAY['FALTA_DE_VOLUME', 'COBRANCA_LEMBRETE']
    ELSE ARRAY['COBRANCA_LEMBRETE']
  END;

  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'nome', nome,
    'descricao', descricao
  ) ORDER BY
    -- Default primeiro (template_id atual da proposta)
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
    'templates_disponiveis', COALESCE(v_templates_disponiveis, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.preview_email_todo(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_email_todo(uuid, text) TO authenticated;
