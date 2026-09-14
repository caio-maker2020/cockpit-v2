-- =============================================================================
-- 2026-09-14_395 — João Penha na visão "todas as perguntas" do teste
-- (Caio 14/09: "quero o joao penha tbm possa ver as perguntas do teste assim
-- como a isadora..libere pro login dele")
-- =============================================================================
-- REPLACE da RPC da mig 394 acrescentando joao.penha@ à lista. Respostas do
-- time seguem só no painel do Caio. TIPO A. Sem BEGIN.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.teste_rel_perguntas_lista()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_email text := (SELECT auth.jwt()->>'email');
BEGIN
  IF v_email IS NULL OR v_email NOT IN
     ('caio@salexpress.com.br',
      'isadora.baldoni@salexpress.com.br',
      'joao.penha@salexpress.com.br') THEN
    RAISE EXCEPTION 'acesso_negado';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('numero', p.ordem, 'pergunta', p.pergunta)
                     ORDER BY p.ordem)
    FROM public.teste_rel_perguntas p
    WHERE p.ativa
  ), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION public.teste_rel_perguntas_lista() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.teste_rel_perguntas_lista() TO authenticated;
