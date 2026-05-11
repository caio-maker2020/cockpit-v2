-- ============================================================================
-- Cockpit v2 — Cadastros de clientes via UI (operador responsável + RPCs)
-- Data: 2026-05-11
--
-- Caio 2026-05-11: aba CADASTROS no front. Larissa (operador) cadastra apenas
-- pros clientes dela; ADM (gestor) cadastra pra qualquer operador (escolhendo
-- o responsável explicitamente). Tudo obrigatório — sem senha tracking o
-- agente não rastreia, sem email não envia.
--
-- Mudanças:
--   1. Adiciona `operador_responsavel_id` em tracking_credentials e
--      contatos_cliente (denormalizado pra RLS funcionar sem join).
--   2. Backfill: aponta tudo existente pra Larissa (única operadora ativa).
--   3. NOT NULL após backfill.
--   4. RLS aberta: operador self; gestor all.
--   5. RPC `cadastrar_cliente_completo` — upsert atomic (tracking +
--      delete-all-contatos + insert-novos + auto-domínio).
--   6. RPC `desativar_cliente` — soft delete (ativo=false em ambas).
--
-- Edge functions (vinculador, executor) usam service_role → bypassam RLS,
-- continuam lendo todas as linhas independente do operador.
-- ============================================================================

-- =============================================================================
-- 1. Vínculo operador responsável
-- =============================================================================
ALTER TABLE public.tracking_credentials
  ADD COLUMN IF NOT EXISTS operador_responsavel_id uuid
    REFERENCES public.operadores(id) ON DELETE RESTRICT;

ALTER TABLE public.contatos_cliente
  ADD COLUMN IF NOT EXISTS operador_responsavel_id uuid
    REFERENCES public.operadores(id) ON DELETE RESTRICT;

-- Backfill: Larissa = única operadora ativa hoje
UPDATE public.tracking_credentials
SET operador_responsavel_id = (
  SELECT id FROM public.operadores
  WHERE email = 'larissa@salexpress.com.br' AND ativo = true
  LIMIT 1
)
WHERE operador_responsavel_id IS NULL;

UPDATE public.contatos_cliente
SET operador_responsavel_id = (
  SELECT id FROM public.operadores
  WHERE email = 'larissa@salexpress.com.br' AND ativo = true
  LIMIT 1
)
WHERE operador_responsavel_id IS NULL;

-- Lock NOT NULL agora que tudo está populado
ALTER TABLE public.tracking_credentials
  ALTER COLUMN operador_responsavel_id SET NOT NULL;

ALTER TABLE public.contatos_cliente
  ALTER COLUMN operador_responsavel_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tracking_credentials_operador
  ON public.tracking_credentials(operador_responsavel_id);

CREATE INDEX IF NOT EXISTS idx_contatos_cliente_operador
  ON public.contatos_cliente(operador_responsavel_id);

-- =============================================================================
-- 2. RLS — operador self; gestor all
-- =============================================================================
DROP POLICY IF EXISTS tracking_credentials_select_gestor ON public.tracking_credentials;
DROP POLICY IF EXISTS tracking_credentials_insert_gestor ON public.tracking_credentials;
DROP POLICY IF EXISTS tracking_credentials_update_gestor ON public.tracking_credentials;
DROP POLICY IF EXISTS tracking_credentials_delete_gestor ON public.tracking_credentials;

CREATE POLICY tc_select ON public.tracking_credentials
  FOR SELECT TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR operador_responsavel_id = public.current_operador_id()
  );

CREATE POLICY tc_insert ON public.tracking_credentials
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_operador_papel() = 'gestor'
    OR operador_responsavel_id = public.current_operador_id()
  );

CREATE POLICY tc_update ON public.tracking_credentials
  FOR UPDATE TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR operador_responsavel_id = public.current_operador_id()
  )
  WITH CHECK (
    public.current_operador_papel() = 'gestor'
    OR operador_responsavel_id = public.current_operador_id()
  );

CREATE POLICY tc_delete ON public.tracking_credentials
  FOR DELETE TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR operador_responsavel_id = public.current_operador_id()
  );

DROP POLICY IF EXISTS contatos_cliente_select_authenticated ON public.contatos_cliente;
DROP POLICY IF EXISTS contatos_cliente_modify_gestor ON public.contatos_cliente;

CREATE POLICY cc_select ON public.contatos_cliente
  FOR SELECT TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR operador_responsavel_id = public.current_operador_id()
  );

CREATE POLICY cc_all ON public.contatos_cliente
  FOR ALL TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR operador_responsavel_id = public.current_operador_id()
  )
  WITH CHECK (
    public.current_operador_papel() = 'gestor'
    OR operador_responsavel_id = public.current_operador_id()
  );

-- =============================================================================
-- 3. RPC cadastrar_cliente_completo
-- =============================================================================
-- Aceita o cliente inteiro (dados básicos + senha + todos os contatos) e faz
-- upsert atômico. Operador: força operador_responsavel = self; gestor: usa
-- p_operador_responsavel_id (obrigatório). Tudo obrigatório por validação
-- dura — sem senha não rastreia, sem email não envia.
--
-- p_contatos formato: jsonb array de objetos
--   [{ "tipo": "email"|"whatsapp", "identificador": "x@y.com" | "31999...",
--      "ordem": 1, "tipo_uso": "geral"|"cobranca"|"logistico"|"financeiro"|"comercial",
--      "nome_pessoa": "...", "cargo": "...", "observacao": "..." }]
--
-- Domínios são auto-inferidos dos emails (split @) — Larissa não preenche.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.cadastrar_cliente_completo(
  p_documento text,
  p_nome text,
  p_senha_tracking text,
  p_contatos jsonb,
  p_operador_responsavel_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    -- Operador: força self, ignora p_operador_responsavel_id
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

  IF p_senha_tracking IS NULL OR length(trim(p_senha_tracking)) = 0 THEN
    RAISE EXCEPTION 'Senha de tracking SSW é obrigatória — sem ela o agente não consegue rastrear o cliente'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

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

  IF v_existing_operador IS NOT NULL THEN
    IF v_operador_papel <> 'gestor' AND v_existing_operador <> v_operador_id THEN
      RAISE EXCEPTION 'Cliente % já está cadastrado e atribuído a outro operador. Só gestor pode reatribuir.', p_documento
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- 5. Upsert tracking_credentials
  INSERT INTO public.tracking_credentials (
    documento, nome_amigavel, senha, notes, ativo,
    operador_responsavel_id, updated_by
  ) VALUES (
    p_documento, trim(p_nome), trim(p_senha_tracking), p_notes, true,
    v_target_operador, v_operador_id
  )
  ON CONFLICT (documento) DO UPDATE
    SET nome_amigavel = EXCLUDED.nome_amigavel,
        senha = EXCLUDED.senha,
        notes = EXCLUDED.notes,
        ativo = true,
        operador_responsavel_id = EXCLUDED.operador_responsavel_id,
        updated_by = EXCLUDED.updated_by;

  -- 6. Rewrite contatos (DELETE + INSERT — mais simples que diff)
  DELETE FROM public.contatos_cliente WHERE documento_cliente = p_documento;

  FOR v_contato IN SELECT * FROM jsonb_array_elements(p_contatos)
  LOOP
    INSERT INTO public.contatos_cliente (
      documento_cliente, tipo, identificador, ordem, tipo_uso,
      nome_pessoa, cargo, observacao, ativo, operador_responsavel_id
    ) VALUES (
      p_documento,
      v_contato->>'tipo',
      trim(v_contato->>'identificador'),
      COALESCE((v_contato->>'ordem')::int, 1),
      COALESCE(v_contato->>'tipo_uso', 'geral'),
      v_contato->>'nome_pessoa',
      v_contato->>'cargo',
      v_contato->>'observacao',
      true,
      v_target_operador
    );
    v_contatos_inseridos := v_contatos_inseridos + 1;

    -- Auto-domínio: cada email gera linha tipo=dominio (dedup intra-call)
    IF v_contato->>'tipo' = 'email' THEN
      v_dominio := lower(split_part(v_contato->>'identificador', '@', 2));
      IF v_dominio <> '' AND NOT (v_dominio = ANY(v_dominios)) THEN
        INSERT INTO public.contatos_cliente (
          documento_cliente, tipo, identificador, ordem, tipo_uso,
          ativo, operador_responsavel_id
        ) VALUES (
          p_documento, 'dominio', v_dominio, 1, 'geral',
          true, v_target_operador
        );
        v_dominios := array_append(v_dominios, v_dominio);
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'documento', p_documento,
    'nome', trim(p_nome),
    'operador_responsavel_id', v_target_operador,
    'contatos_inseridos', v_contatos_inseridos,
    'dominios_inferidos', v_dominios
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cadastrar_cliente_completo(text, text, text, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cadastrar_cliente_completo(text, text, text, jsonb, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.cadastrar_cliente_completo(text, text, text, jsonb, uuid, text) IS
  'Caio 2026-05-11: upsert atômico de cliente (tracking_credentials + N contatos_cliente). '
  'Operador força operador_responsavel=self; gestor passa p_operador_responsavel_id explícito. '
  'Validações duras: documento 11/14 dígitos, nome/senha obrigatórios, ≥1 email. '
  'Auto-cria linha tipo=dominio pra cada email distinto. Anti-roubo: operador não pode '
  'sobrescrever cliente de outro operador (só gestor).';

-- =============================================================================
-- 4. RPC desativar_cliente
-- =============================================================================
CREATE OR REPLACE FUNCTION public.desativar_cliente(p_documento text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_target_operador uuid;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() AND ativo = true LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT operador_responsavel_id INTO v_target_operador
  FROM public.tracking_credentials WHERE documento = p_documento;

  IF v_target_operador IS NULL THEN
    RAISE EXCEPTION 'Cliente % não encontrado', p_documento
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor' AND v_target_operador <> v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra desativar cliente %', p_documento
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.tracking_credentials SET ativo = false WHERE documento = p_documento;
  UPDATE public.contatos_cliente SET ativo = false WHERE documento_cliente = p_documento;

  RETURN jsonb_build_object('ok', true, 'documento', p_documento, 'ativo', false);
END;
$$;

REVOKE ALL ON FUNCTION public.desativar_cliente(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desativar_cliente(text) TO authenticated;

COMMENT ON FUNCTION public.desativar_cliente(text) IS
  'Caio 2026-05-11: soft-delete do cliente (ativo=false em tracking_credentials + contatos_cliente). '
  'Operador desativa só os seus; gestor desativa qualquer. Cockpit deixa de usar contatos '
  'inativos automaticamente — vinculador / executor filtram ativo=true.';
