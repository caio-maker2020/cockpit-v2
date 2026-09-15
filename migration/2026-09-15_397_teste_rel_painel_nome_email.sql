-- =============================================================================
-- 2026-09-15_397 — painel do teste: nome cai pro e-mail quando não é operador
-- =============================================================================
-- Caio 15/09 criou login pro estagiário GABRIEL (gabriel.patricio@) responder
-- o teste. Ele NÃO está em `operadores` — o painel (mig 393) fazia
-- COALESCE(o.nome, user_id::text) e mostraria um UUID. Agora: nome do
-- operador → senão e-mail da auth → senão UUID. REPLACE de teste_rel_painel,
-- resto idêntico à mig 393. TIPO A. Sem BEGIN.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.teste_rel_painel()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_email text := (SELECT auth.jwt()->>'email');
BEGIN
  IF v_email IS DISTINCT FROM 'caio@salexpress.com.br' THEN
    RAISE EXCEPTION 'acesso_negado';
  END IF;
  RETURN jsonb_build_object(
    'total_perguntas', (SELECT count(*) FROM public.teste_rel_perguntas WHERE ativa),
    'status', COALESCE((
      SELECT jsonb_agg(s ORDER BY s->>'nome')
      FROM (
        SELECT jsonb_build_object(
          'nome', COALESCE(o.nome, au.email::text, r.user_id::text),
          'email', COALESCE(o.email, au.email::text),
          'respondidas', count(*),
          'primeira_em', min(r.enviado_em),
          'ultima_em', max(r.enviado_em),
          'tempo_total_ms', sum(coalesce(r.tempo_ms, 0)),
          'colagens', sum(r.paste_count)
        ) AS s
        FROM public.teste_rel_respostas r
        LEFT JOIN public.operadores o ON o.user_id = r.user_id
        LEFT JOIN auth.users au ON au.id = r.user_id
        GROUP BY o.nome, o.email, au.email, r.user_id
      ) x
    ), '[]'::jsonb),
    'respostas', COALESCE((
      SELECT jsonb_agg(j ORDER BY (j->>'nome'), (j->>'ordem')::int)
      FROM (
        SELECT jsonb_build_object(
          'nome', COALESCE(o.nome, au.email::text, r.user_id::text),
          'ordem', p.ordem,
          'pergunta_id', p.id,
          'frente', p.frente,
          'pergunta', p.pergunta,
          'resposta', r.resposta,
          'tempo_ms', r.tempo_ms,
          'n_chars', r.n_chars,
          'paste_count', r.paste_count,
          'meta', r.meta,
          'enviado_em', r.enviado_em
        ) AS j
        FROM public.teste_rel_respostas r
        JOIN public.teste_rel_perguntas p ON p.id = r.pergunta_id
        LEFT JOIN public.operadores o ON o.user_id = r.user_id
        LEFT JOIN auth.users au ON au.id = r.user_id
      ) y
    ), '[]'::jsonb)
  );
END $$;

REVOKE ALL ON FUNCTION public.teste_rel_painel() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.teste_rel_painel() TO authenticated;
