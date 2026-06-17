-- ============================================================================
-- Cockpit v2 — Gestão de credenciais de operador (Caio 2026-06-17)
--
-- Suporta 2 features novas (lógica nas edge functions, não em RPC, porque exigem
-- o Supabase Auth Admin API com service_role):
--   1. Painel SÓ do Caio (caio@salexpress.com.br) pra trocar login/senha de
--      qualquer operador  -> edge `admin-operadores`.
--   2. "Esqueci minha senha" na tela de login: gera senha nova e envia por e-mail
--      (Postmark) pro e-mail cadastrado do operador -> edge `recuperar-senha-operador`.
--
-- Esta migration cria só a TRILHA DE AUDITORIA dessas ações. NUNCA guardar senha
-- em claro aqui. Cooldown do self-service de reset é derivado desta tabela
-- (último evento reset_senha_self por operador), sem coluna extra.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.operador_credencial_eventos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operador_id uuid NOT NULL REFERENCES public.operadores(id) ON DELETE CASCADE,
  tipo        text NOT NULL CHECK (tipo IN (
                'reset_senha_self',   -- operador clicou "Esqueci minha senha"
                'admin_set_senha',    -- Caio trocou a senha
                'admin_set_login',    -- Caio trocou o e-mail/login
                'admin_criou_login'   -- Caio criou login pra operador sem auth
              )),
  ator_email  text,                                    -- quem disparou (caio@... ou 'self-service')
  detalhe     jsonb NOT NULL DEFAULT '{}'::jsonb,      -- metadados; SEM senha em claro
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.operador_credencial_eventos IS
  'Auditoria de mudanças de credencial de operador (reset self-service + ações do '
  'admin Caio). NUNCA armazenar senha em claro em `detalhe`. Cooldown do reset '
  'self-service deriva do último evento reset_senha_self por operador.';

-- Índice pro cooldown/listagem por operador (último evento primeiro).
CREATE INDEX IF NOT EXISTS idx_cred_eventos_operador_recente
  ON public.operador_credencial_eventos (operador_id, created_at DESC);

-- RLS: só gestor lê (o painel do Caio pode exibir o histórico). INSERT vem só do
-- service_role (edge functions), que ignora RLS — nenhuma policy de write pra
-- authenticated (princípio do menor privilégio).
ALTER TABLE public.operador_credencial_eventos ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.operador_credencial_eventos TO authenticated;

DROP POLICY IF EXISTS cred_eventos_gestor_select ON public.operador_credencial_eventos;
CREATE POLICY cred_eventos_gestor_select
  ON public.operador_credencial_eventos
  FOR SELECT
  TO authenticated
  USING (public.current_operador_papel() = 'gestor');
