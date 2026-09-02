-- =============================================================================
-- 2026-09-01_372 — PLAYBOOK DE VETOS no monitor (Caio 01/09)
-- =============================================================================
-- Última fase da caça aos vetos: 19 dos 20 vetos dos 7 dias viraram 6 regras
-- propostas + 1 exceção de cliente. As 13 perguntas de confirmação vão pro
-- TIME responder num link do monitor Vercel (playbook-vetos.html), com os
-- casos reais (NFs) pra consulta. Mesma arquitetura da sombra-49: página
-- estática + RPC SECURITY DEFINER gated por token em monitor_tokens
-- (escopo 'playbook_vetos'; valor do token NUNCA no repo — insert manual).
-- TIPO A (aditiva, reversível). Sem BEGIN/COMMIT. Idempotente.
-- skill: supabase-postgres-best-practices aplicada (RLS, definer, search_path).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.playbook_vetos_respostas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pergunta_id   text NOT NULL,
  operador_nome text NOT NULL,
  resposta      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- acesso SÓ via RPC definer (sem policy = ninguém lê/escreve direto)
ALTER TABLE public.playbook_vetos_respostas ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_playbook_vetos_pergunta
  ON public.playbook_vetos_respostas (pergunta_id, created_at);

-- ---------------------------------------------------------------------------
-- leitura: todas as respostas já dadas (o time vê o que colegas responderam)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.playbook_vetos_ler(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.monitor_tokens
                  WHERE token = p_token AND escopo = 'playbook_vetos') THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  RETURN jsonb_build_object('respostas',
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'pergunta_id', r.pergunta_id,
        'operador',    r.operador_nome,
        'resposta',    r.resposta,
        'em', to_char(r.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI')
      ) ORDER BY r.created_at)
      FROM public.playbook_vetos_respostas r), '[]'::jsonb));
END $fn$;

-- ---------------------------------------------------------------------------
-- escrita: uma resposta por envio; várias operadoras podem responder a mesma
-- pergunta (complemento é riqueza — mesma filosofia do feedback da 49)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.playbook_vetos_responder(
  p_token text, p_pergunta_id text, p_operador text, p_resposta text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.monitor_tokens
                  WHERE token = p_token AND escopo = 'playbook_vetos') THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  IF p_pergunta_id !~ '^p([1-9]|1[0-3])$' THEN
    RAISE EXCEPTION 'pergunta invalida';
  END IF;
  IF length(btrim(coalesce(p_operador, ''))) < 2 THEN
    RAISE EXCEPTION 'informe seu nome';
  END IF;
  IF length(btrim(coalesce(p_resposta, ''))) < 10 THEN
    RAISE EXCEPTION 'resposta muito curta — detalhe pra valer como regra';
  END IF;
  INSERT INTO public.playbook_vetos_respostas (pergunta_id, operador_nome, resposta)
  VALUES (p_pergunta_id, upper(btrim(p_operador)), btrim(p_resposta));
  RETURN jsonb_build_object('ok', true);
END $fn$;

REVOKE ALL ON FUNCTION public.playbook_vetos_ler(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.playbook_vetos_responder(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.playbook_vetos_ler(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.playbook_vetos_responder(text, text, text, text) TO anon, authenticated, service_role;
