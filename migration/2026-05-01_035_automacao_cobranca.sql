-- ============================================================================
-- Cockpit v2 — Schema da automação de cobrança automática
-- Data: 2026-05-01
--
-- Cria a infraestrutura completa pra:
-- (1) Cadastrar contatos de cliente (email/whatsapp/dominio) com ordem +
--     tipo_uso, alimenta planilha que Larissa preenche.
-- (2) Cadastrar templates de email reutilizáveis (FALTA_DE_VOLUME, etc).
-- (3) Agendar ações futuras (ex: "cobrar cliente em D+4 se sem retorno").
--
-- Quando Larissa entregar templates_email + contatos preenchidos, a
-- automação dispara automaticamente. Hoje fica pronta-mas-bloqueada.
-- ============================================================================

-- =============================================================================
-- 1. contatos_cliente
-- =============================================================================
-- Compatível com a planilha Contatos-Clientes-Larissa.xlsx (aba Contatos):
-- tipo, identificador, documento_cliente, nome_pessoa, cargo, observacao, ativo.
-- Mais 2 campos novos: ordem (preferência) e tipo_uso (qual processo).
CREATE TABLE IF NOT EXISTS public.contatos_cliente (
  id                bigserial PRIMARY KEY,
  documento_cliente text NOT NULL,
  tipo              text NOT NULL CHECK (tipo IN ('email', 'whatsapp', 'dominio')),
  identificador     text NOT NULL,
  ordem             int NOT NULL DEFAULT 1 CHECK (ordem >= 1),
  tipo_uso          text NOT NULL DEFAULT 'geral'
                    CHECK (tipo_uso IN ('geral', 'cobranca', 'logistico', 'financeiro', 'comercial')),
  nome_pessoa       text,
  cargo             text,
  observacao        text,
  ativo             boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contatos_cliente_doc_tipo
  ON public.contatos_cliente(documento_cliente, tipo, ativo);

CREATE INDEX IF NOT EXISTS idx_contatos_cliente_dominio
  ON public.contatos_cliente(identificador) WHERE tipo = 'dominio' AND ativo = true;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'contatos_cliente_set_updated_at') THEN
    CREATE TRIGGER contatos_cliente_set_updated_at
      BEFORE UPDATE ON public.contatos_cliente
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

ALTER TABLE public.contatos_cliente ENABLE ROW LEVEL SECURITY;

CREATE POLICY contatos_cliente_select_authenticated ON public.contatos_cliente
  FOR SELECT TO authenticated USING (true);

CREATE POLICY contatos_cliente_modify_gestor ON public.contatos_cliente
  FOR ALL TO authenticated
  USING (public.current_operador_papel() = 'gestor')
  WITH CHECK (public.current_operador_papel() = 'gestor');

COMMENT ON TABLE public.contatos_cliente IS
  'Contatos do cliente (email/whatsapp/dominio) usados pelo Cockpit pra '
  'enviar mensagens automaticas. Populado a partir de Contatos-Clientes-Larissa.xlsx '
  'via script de import. Larissa adiciona/edita conforme novos clientes.';

-- =============================================================================
-- 2. templates_email
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.templates_email (
  id                  text PRIMARY KEY,            -- 'FALTA_DE_VOLUME', 'COBRANCA_LEMBRETE'
  nome                text NOT NULL,
  descricao           text,                        -- quando usar
  assunto             text NOT NULL,
  corpo_template      text NOT NULL,               -- com {placeholders}
  variaveis_esperadas text[] NOT NULL DEFAULT '{}', -- ['nome_cliente', 'nf', ...] informativo
  ativo               boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'templates_email_set_updated_at') THEN
    CREATE TRIGGER templates_email_set_updated_at
      BEFORE UPDATE ON public.templates_email
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

ALTER TABLE public.templates_email ENABLE ROW LEVEL SECURITY;

CREATE POLICY templates_email_select_authenticated ON public.templates_email
  FOR SELECT TO authenticated USING (true);

CREATE POLICY templates_email_modify_gestor ON public.templates_email
  FOR ALL TO authenticated
  USING (public.current_operador_papel() = 'gestor')
  WITH CHECK (public.current_operador_papel() = 'gestor');

COMMENT ON TABLE public.templates_email IS
  'Templates de email reutilizaveis com placeholders entre {chaves}. '
  'Populado a partir do doc Templates-Email-Larissa.docx que Larissa preenche.';

-- Stub do template FALTA_DE_VOLUME pra unblock testes — Larissa sobrescreve depois
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'FALTA_DE_VOLUME',
  'Falta de volume — solicitar tratativa',
  'Quando chega no destino faltando volumes e cliente precisa decidir entre aguardar / parcial / devolver',
  '[Sal Express] NF {nf} — falta de volume',
  E'Olá {primeiro_nome},\n\n' ||
  E'Identificamos que a NF {nf} chegou ao destino com {n_volumes_falta} volume(s) faltando.\n\n' ||
  E'Como prefere prosseguir?\n' ||
  E'1) Aguardar localização do(s) volume(s)\n' ||
  E'2) Autorizar entrega parcial dos volumes que chegaram\n' ||
  E'3) Recusar e pedir devolução total\n\n' ||
  E'Aguardo retorno.\n\n' ||
  E'{operadora_nome}\nSal Express — Relacionamento',
  ARRAY['primeiro_nome', 'nf', 'n_volumes_falta', 'operadora_nome'],
  false  -- inativo até Larissa revisar e aprovar texto final
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'COBRANCA_LEMBRETE',
  'Cobrança de lembrete — sem retorno após 4 dias',
  'Reenvio quando cliente não respondeu o email anterior em 4 dias',
  '[Sal Express] Re: NF {nf} — aguardando seu retorno',
  E'Olá {primeiro_nome},\n\n' ||
  E'Tudo bem? Estou retomando o assunto da NF {nf} — ainda não recebi seu retorno.\n\n' ||
  E'Pra eu seguir com a tratativa, preciso da sua orientação.\n\n' ||
  E'Aguardo um retorno seu.\n\n' ||
  E'{operadora_nome}\nSal Express — Relacionamento',
  ARRAY['primeiro_nome', 'nf', 'operadora_nome'],
  false  -- inativo até Larissa revisar
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 3. acoes_agendadas
-- =============================================================================
-- Relógio das ações automáticas. Cron `processar-acoes-agendadas` roda
-- diário e pega tudo onde executar_em <= now() AND status = 'pendente'.
CREATE TABLE IF NOT EXISTS public.acoes_agendadas (
  id            bigserial PRIMARY KEY,
  card_id       uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  tipo          text NOT NULL CHECK (tipo IN ('cobranca_email')),
  executar_em   timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'pendente'
                CHECK (status IN ('pendente', 'processado', 'cancelado')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  cancelado_motivo text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_acoes_agendadas_pendentes
  ON public.acoes_agendadas(executar_em)
  WHERE status = 'pendente';

CREATE INDEX IF NOT EXISTS idx_acoes_agendadas_card
  ON public.acoes_agendadas(card_id, status);

ALTER TABLE public.acoes_agendadas ENABLE ROW LEVEL SECURITY;

CREATE POLICY acoes_agendadas_select_authenticated ON public.acoes_agendadas
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = acoes_agendadas.card_id
        AND public.card_visivel_pelo_operador_atual(c.assigned_operator_id, c.pagador, c.segmento_codigo)
    )
  );

COMMENT ON TABLE public.acoes_agendadas IS
  'Agenda de ações automáticas futuras (ex: cobrar cliente em D+4). Cron '
  'processar-acoes-agendadas pega pendentes a cada dia e dispara. Cancela '
  'quando cliente responde antes do prazo.';

-- =============================================================================
-- 4. RPC: cancelar_acoes_agendadas_do_card — usado pelo vinculador quando
--    cliente responde, automaticamente para o relógio
-- =============================================================================
CREATE OR REPLACE FUNCTION public.cancelar_acoes_agendadas_do_card(
  p_card_id uuid,
  p_motivo text DEFAULT 'cliente respondeu'
) RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH canceladas AS (
    UPDATE public.acoes_agendadas
    SET status = 'cancelado',
        cancelado_motivo = p_motivo
    WHERE card_id = p_card_id AND status = 'pendente'
    RETURNING 1
  )
  SELECT count(*)::int FROM canceladas;
$$;

GRANT EXECUTE ON FUNCTION public.cancelar_acoes_agendadas_do_card(uuid, text) TO service_role;

-- =============================================================================
-- 5. RPC: agendar_cobranca_email — usado pelo enviar-resposta após envio OK
-- =============================================================================
CREATE OR REPLACE FUNCTION public.agendar_cobranca_email(
  p_card_id uuid,
  p_template_id text,
  p_dias int DEFAULT 4
) RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.acoes_agendadas (card_id, tipo, executar_em, payload)
  VALUES (
    p_card_id,
    'cobranca_email',
    now() + make_interval(days => p_dias),
    jsonb_build_object(
      'template_id', p_template_id,
      'dias_aguardar', p_dias,
      'agendado_em', now()
    )
  )
  RETURNING id;
$$;

GRANT EXECUTE ON FUNCTION public.agendar_cobranca_email(uuid, text, int) TO service_role;

-- =============================================================================
-- 6. RPC: resolver_email_cobranca_cliente — busca melhor email pra processo
--    Retorna 1 string ou NULL se cliente não tem contato cadastrado
-- =============================================================================
CREATE OR REPLACE FUNCTION public.resolver_email_cobranca_cliente(
  p_documento_cliente text,
  p_tipo_uso text DEFAULT 'cobranca'
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT identificador
  FROM public.contatos_cliente
  WHERE documento_cliente = p_documento_cliente
    AND tipo = 'email'
    AND ativo = true
    AND tipo_uso IN (p_tipo_uso, 'geral')
  ORDER BY
    -- Preferir tipo_uso específico antes de 'geral'
    CASE WHEN tipo_uso = p_tipo_uso THEN 0 ELSE 1 END,
    ordem ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.resolver_email_cobranca_cliente(text, text) TO service_role, authenticated;
