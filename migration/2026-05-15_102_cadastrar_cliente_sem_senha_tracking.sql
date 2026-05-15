-- Migration 102: cadastrar_cliente_completo torna p_senha_tracking opcional.
--
-- CONTEXTO (Caio 2026-05-15):
-- Tracking SSW público está deprecated (Fase 3 — SSW interno cobre 100%).
-- Mas a RPC `cadastrar_cliente_completo` ainda exigia senha de tracking,
-- bloqueando Duilio de cadastrar clientes novos pela aba CADASTROS do Lovable.
--
-- Fix: senha vira opcional. Quando não fornecida, tracking_credentials é
-- inserida com senha NULL — operador vê cliente na aba CADASTROS e SSW
-- interno cobre a operação. Front Lovable pode parar de pedir o campo.
--
-- Mantém:
-- - Validação documento (11 ou 14 dígitos)
-- - Validação nome obrigatório
-- - Validação ≥1 contato email
-- - Anti-roubo de cliente (NOT EXISTS owned by outro operador)
-- - Resto da lógica intocada

CREATE OR REPLACE FUNCTION public.cadastrar_cliente_completo(
  p_documento text,
  p_nome text,
  p_senha_tracking text DEFAULT NULL,  -- Caio 2026-05-15: era obrigatório, agora opcional
  p_contatos jsonb DEFAULT '[]'::jsonb,
  p_operador_responsavel_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_target_operador uuid;
  v_existing_operador uuid;
  v_contato jsonb;
  v_email_count int := 0;
  v_dominios text[] := '{}';
  v_dominio text;
  v_contatos_inseridos int := 0;
  v_senha_normalizada text;
BEGIN
  -- 1. Auth
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() AND ativo = true LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2. Resolve operador_responsavel
  IF v_operador_papel = 'gestor' THEN
    IF p_operador_responsavel_id IS NULL THEN
      RAISE EXCEPTION 'Gestor deve indicar p_operador_responsavel_id (qual operador é dono desse cliente)'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.operadores WHERE id = p_operador_responsavel_id AND ativo = true) THEN
      RAISE EXCEPTION 'Operador % não existe ou está inativo', p_operador_responsavel_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_target_operador := p_operador_responsavel_id;
  ELSE
    v_target_operador := v_operador_id;
  END IF;

  -- 3. Validações duras
  IF p_documento IS NULL OR p_documento !~ '^\d+$' OR length(p_documento) NOT IN (11, 14) THEN
    RAISE EXCEPTION 'Documento inválido: deve ter 11 (CPF) ou 14 (CNPJ) dígitos numéricos. Recebido: %', p_documento
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_nome IS NULL OR length(trim(p_nome)) = 0 THEN
    RAISE EXCEPTION 'Nome do cliente é obrigatório'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Caio 2026-05-15: senha de tracking SSW deixou de ser obrigatória.
  -- Tracking público deprecated; SSW interno (101) cobre. Normaliza vazio→NULL.
  v_senha_normalizada := NULLIF(trim(coalesce(p_senha_tracking, '')), '');

  IF p_contatos IS NULL OR jsonb_typeof(p_contatos) <> 'array' OR jsonb_array_length(p_contatos) = 0 THEN
    RAISE EXCEPTION 'Cliente precisa de pelo menos 1 contato (email obrigatório)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_contato IN SELECT * FROM jsonb_array_elements(p_contatos)
  LOOP
    IF v_contato->>'tipo' NOT IN ('email', 'whatsapp') THEN
      RAISE EXCEPTION 'Tipo de contato inválido: % (válidos: email, whatsapp)', v_contato->>'tipo'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_contato->>'tipo' = 'email' THEN
      IF v_contato->>'identificador' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RAISE EXCEPTION 'Email inválido: %', v_contato->>'identificador'
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_email_count := v_email_count + 1;
    END IF;
    IF v_contato->>'identificador' IS NULL OR length(trim(v_contato->>'identificador')) = 0 THEN
      RAISE EXCEPTION 'Identificador do contato é obrigatório'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;

  IF v_email_count = 0 THEN
    RAISE EXCEPTION 'Cliente precisa de pelo menos 1 contato do tipo email — sem ele Cockpit não envia mensagens'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 4. Checa propriedade existente (anti-roubo de cliente)
  SELECT operador_responsavel_id INTO v_existing_operador
  FROM public.tracking_credentials WHERE documento = p_documento;

  IF v_existing_operador IS NOT NULL AND v_existing_operador <> v_target_operador THEN
    IF v_operador_papel <> 'gestor' THEN
      RAISE EXCEPTION 'Cliente % já está cadastrado pra outro operador. Peça ao gestor pra transferir se necessário.', p_documento
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- 5. Upsert tracking_credentials (senha pode ser NULL)
  INSERT INTO public.tracking_credentials (
    documento, nome_amigavel, senha, notes, ativo,
    operador_responsavel_id, updated_by
  ) VALUES (
    p_documento, trim(p_nome), v_senha_normalizada, p_notes, true,
    v_target_operador, v_operador_id
  )
  ON CONFLICT (documento) DO UPDATE
    SET nome_amigavel = EXCLUDED.nome_amigavel,
        senha = EXCLUDED.senha,
        notes = EXCLUDED.notes,
        ativo = true,
        operador_responsavel_id = EXCLUDED.operador_responsavel_id,
        updated_by = EXCLUDED.updated_by;

  -- 5b. Upsert em clientes (pra aparecer na carteira/RLS)
  INSERT INTO public.clientes (cnpj_cpf, nome, ativo)
  VALUES (p_documento, trim(p_nome), true)
  ON CONFLICT (cnpj_cpf) DO UPDATE
    SET nome = EXCLUDED.nome, ativo = true, updated_at = now();

  -- 5c. Adiciona CNPJ na carteira do operador-dono (idempotente)
  UPDATE public.operadores
  SET carteira = array(SELECT DISTINCT unnest(carteira || p_documento))
  WHERE id = v_target_operador
    AND NOT (p_documento = ANY(carteira));

  -- 6. Rewrite contatos (DELETE + INSERT)
  DELETE FROM public.contatos_cliente WHERE documento_cliente = p_documento;

  FOR v_contato IN SELECT * FROM jsonb_array_elements(p_contatos)
  LOOP
    INSERT INTO public.contatos_cliente (
      documento_cliente, tipo, identificador, nome_pessoa, cargo, observacao,
      operador_responsavel_id, ativo, ordem, tipo_uso
    ) VALUES (
      p_documento,
      v_contato->>'tipo',
      lower(trim(v_contato->>'identificador')),
      v_contato->>'nome_pessoa',
      v_contato->>'cargo',
      v_contato->>'observacao',
      v_target_operador,
      true,
      coalesce((v_contato->>'ordem')::int, 1),
      coalesce(v_contato->>'tipo_uso', 'geral')
    );
    v_contatos_inseridos := v_contatos_inseridos + 1;

    -- Coleta domínios pra retorno
    IF v_contato->>'tipo' = 'email' THEN
      v_dominio := split_part(lower(trim(v_contato->>'identificador')), '@', 2);
      IF v_dominio <> '' AND NOT (v_dominio = ANY(v_dominios)) THEN
        v_dominios := array_append(v_dominios, v_dominio);
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'documento', p_documento,
    'operador_id', v_target_operador,
    'contatos_inseridos', v_contatos_inseridos,
    'dominios', v_dominios,
    'senha_tracking_setada', v_senha_normalizada IS NOT NULL
  );
END;
$function$;

COMMENT ON FUNCTION public.cadastrar_cliente_completo IS
  'Cadastra cliente + contatos + tracking_credentials + carteira do operador. '
  'Senha de tracking opcional (Caio 2026-05-15) — tracking público deprecated, '
  'SSW interno cobre. Front Lovable pode parar de exigir o campo. Anti-roubo '
  'de cliente: se documento já pertence a outro operador, só gestor transfere.';
