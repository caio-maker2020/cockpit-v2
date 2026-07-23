-- 2026-07-23_307 — F4: Popup de divergência (fundação de dados)
--
-- Quando o operador aprova uma ação DIFERENTE da destacada pela IA, o front
-- (atrás de flag por operador, default DESLIGADO) pede 1 chip de motivo do
-- motivo_bank + texto opcional. O motivo NÃO cria par novo (o feedback
-- implícito do executor já registra o par — evita dupla contagem na view
-- unificada); vive em tabela própria, ligável por card_id/todo_id.

BEGIN;

CREATE TABLE public.divergencia_motivos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  todo_id uuid REFERENCES public.todos(id) ON DELETE SET NULL,
  operador_id uuid REFERENCES public.operadores(id) ON DELETE SET NULL,
  acao_key_sugerida text,
  acao_key_aprovada text,
  reason_code text NOT NULL,
  reason_text text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.divergencia_motivos IS
  'Motivo estruturado dado pelo operador no popup de divergência (F4). Um por aprovação divergente; liga ao par implícito por card_id/todo_id.';

CREATE INDEX idx_divergencia_motivos_card ON public.divergencia_motivos (card_id);
CREATE INDEX idx_divergencia_motivos_dia
  ON public.divergencia_motivos (created_at DESC);

ALTER TABLE public.divergencia_motivos ENABLE ROW LEVEL SECURITY;
CREATE POLICY divergencia_motivos_select_gestor ON public.divergencia_motivos
  FOR SELECT TO authenticated
  USING ((SELECT public.current_operador_papel()) = 'gestor');
-- INSERT só via RPC (SECURITY DEFINER) — sem policy direta de propósito.

-- Piloto por operador: o popup só liga pra quem estiver aqui com ativo=true.
CREATE TABLE public.popup_divergencia_config (
  operador_email text PRIMARY KEY,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.popup_divergencia_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY popup_divergencia_config_select ON public.popup_divergencia_config
  FOR SELECT TO authenticated
  USING (
    (SELECT public.current_operador_papel()) = 'gestor'
    OR lower(operador_email) = lower(coalesce(
         (SELECT o.email FROM public.operadores o
           WHERE o.id = (SELECT public.current_operador_id())), ''))
  );
-- escrita só service_role/gestor via SQL (piloto é decisão de gestão)

-- RPC usada pelo OPERADOR no popup (qualquer operador autenticado ativo)
CREATE OR REPLACE FUNCTION public.registrar_motivo_divergencia(
  p_card_id uuid,
  p_todo_id uuid,
  p_acao_key_sugerida text,
  p_acao_key_aprovada text,
  p_reason_code text,
  p_reason_text text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_id uuid;
BEGIN
  v_operador_id := public.current_operador_id();
  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não identificado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.motivo_bank
    WHERE contexto = 'popup_divergencia'
      AND codigo = p_reason_code
      AND status = 'aprovado'
  ) THEN
    RAISE EXCEPTION 'Motivo inválido: %', p_reason_code;
  END IF;

  INSERT INTO public.divergencia_motivos (
    card_id, todo_id, operador_id,
    acao_key_sugerida, acao_key_aprovada, reason_code, reason_text
  ) VALUES (
    p_card_id, p_todo_id, v_operador_id,
    p_acao_key_sugerida, p_acao_key_aprovada, p_reason_code,
    nullif(trim(coalesce(p_reason_text, '')), '')
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_motivo_divergencia(uuid, uuid, text, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_motivo_divergencia(uuid, uuid, text, text, text, text)
  TO authenticated, service_role;

COMMIT;
