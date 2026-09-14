-- =============================================================================
-- 2026-09-14_394 — visão "todas as perguntas" pra Isadora (Caio 14/09:
-- "libere o login da isadora para ela visualizar todas as perguntas")
-- =============================================================================
-- RPC que lista as 25 perguntas (ordem + texto, SEM frente/gabarito — gabarito
-- não existe no banco). Permitida só pra caio@ e isadora.baldoni@ — o restante
-- do time segue vendo uma pergunta por vez pelo fluxo normal. As RESPOSTAS do
-- time continuam só no painel do Caio (teste_rel_painel inalterada).
-- TIPO A. Sem BEGIN. skill supabase-postgres-best-practices aplicada.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.teste_rel_perguntas_lista()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_email text := (SELECT auth.jwt()->>'email');
BEGIN
  IF v_email IS NULL OR v_email NOT IN
     ('caio@salexpress.com.br', 'isadora.baldoni@salexpress.com.br') THEN
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
