-- ============================================================================
-- Cockpit v2 — tabela tracking_credentials (CPF/CNPJ pagador → senha tracking)
-- Data: 2026-04-29
--
-- Cada cliente da Sal Express (pagador) tem uma senha de tracking própria,
-- configurada pela transportadora no SSW. Essa tabela mapeia documento → senha
-- pra que o vinculador, ao chamar /api/trackingpag, saiba qual senha usar
-- por cada cliente que aparecer numa mensagem entrante.
--
-- Schema deliberadamente simples: gestor adiciona/edita via UI Lovable
-- (Configurações). Nada de RLS por carteira aqui — credenciais são
-- compartilhadas pelo time todo (qualquer operador no relacionamento pode
-- precisar puxar tracking de qualquer pagador).
-- ============================================================================

CREATE TABLE public.tracking_credentials (
  -- Documento normalizado (apenas dígitos): CPF (11) ou CNPJ (14).
  documento text PRIMARY KEY CHECK (length(documento) IN (11, 14) AND documento ~ '^\d+$'),
  -- Nome amigável do cliente (pra UI mostrar "FUTURA COMERCIO" em vez do CPF).
  nome_amigavel text,
  -- Senha de tracking do pagador no SSW. Pode ser NULL se a config do SSW
  -- permitir tracking sem senha pra esse cliente.
  senha text,
  -- Free-form notes (ex.: "ligou em 2026-04-15, senha trocada").
  notes text,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.operadores(id) ON DELETE SET NULL
);

CREATE INDEX idx_tracking_credentials_ativo
  ON public.tracking_credentials(ativo)
  WHERE ativo = true;

CREATE TRIGGER tracking_credentials_set_updated_at
  BEFORE UPDATE ON public.tracking_credentials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS: só gestor manipula; operador não lê (é segredo da operação).
-- Edge Functions usam service_role e bypassam RLS.
-- ============================================================================
ALTER TABLE public.tracking_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY tracking_credentials_select_gestor ON public.tracking_credentials
  FOR SELECT TO authenticated
  USING (public.current_operador_papel() = 'gestor');

CREATE POLICY tracking_credentials_insert_gestor ON public.tracking_credentials
  FOR INSERT TO authenticated
  WITH CHECK (public.current_operador_papel() = 'gestor');

CREATE POLICY tracking_credentials_update_gestor ON public.tracking_credentials
  FOR UPDATE TO authenticated
  USING (public.current_operador_papel() = 'gestor');

CREATE POLICY tracking_credentials_delete_gestor ON public.tracking_credentials
  FOR DELETE TO authenticated
  USING (public.current_operador_papel() = 'gestor');

-- ============================================================================
-- Seed: cliente teste com CPF + senha que Caio passou
-- ============================================================================
INSERT INTO public.tracking_credentials (documento, nome_amigavel, senha, notes, ativo)
VALUES (
  '13648530607',
  'Cliente Teste (Caio)',
  '1',
  'Cliente simulado pra testes de integração. NFs criadas manualmente pela operação.',
  true
)
ON CONFLICT (documento) DO NOTHING;

COMMENT ON TABLE public.tracking_credentials IS
  'Mapeia CPF/CNPJ do pagador → senha de tracking SSW (/api/trackingpag). '
  'Gestor edita via UI; vinculador consome via service_role pra puxar info de '
  'NFs que não estão no Bastão.';
