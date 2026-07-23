-- 2026-07-23_308 — F5: sugestoes_texto_ia (instrumenta os "cegos" de texto)
--
-- redator-email-saida e sugerir-cobranca-ai geravam texto e devolviam pro
-- navegador SEM registrar nada — impossível medir quanto do texto da IA
-- sobrevive à edição do operador. Agora toda geração é persistida aqui
-- (best-effort, nunca bloqueia a resposta). Comparação posterior:
--   email_saida → cards_emails_outbound.corpo_renderizado (por card/todo)
--   cobranca    → cobrancas_disparadas.texto_enviado (por card/papel/canal)

BEGIN;

CREATE TABLE public.sugestoes_texto_ia (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('email_saida','cobranca')),
  codigo_ssw integer,
  papel text,
  canal text,
  assunto_sugerido text,
  texto_sugerido text NOT NULL,
  modelo text,
  gerado_em timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sugestoes_texto_ia IS
  'Texto sugerido pela IA (redator de e-mail de saída / cobrança) — F5 do Loop de Aprendizado. Antes disso, a sugestão evaporava e o agente era imensurável.';

CREATE INDEX idx_sugestoes_texto_card ON public.sugestoes_texto_ia (card_id);
CREATE INDEX idx_sugestoes_texto_tipo_dia
  ON public.sugestoes_texto_ia (tipo, gerado_em DESC);

ALTER TABLE public.sugestoes_texto_ia ENABLE ROW LEVEL SECURITY;
CREATE POLICY sugestoes_texto_select_gestor ON public.sugestoes_texto_ia
  FOR SELECT TO authenticated
  USING ((SELECT public.current_operador_papel()) = 'gestor');
-- escrita só service_role (edge functions) — sem policy de propósito

COMMIT;
