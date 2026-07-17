-- 2026-07-17_301 — Loop de Aprendizado (Fase 2): contrato de dados do painel
--
-- 1) RPC responder_pergunta_aprendizado — o "1 clique" da Isadora/Caio:
--    grava a resposta como linha nova (memória institucional, parent_id) e
--    marca a pergunta como respondida. Gestor-only (SECURITY DEFINER —
--    learning_log não tem INSERT policy pra authenticated, de propósito).
-- 2) v_sinal_ouro_trocas — "sugerido × feito no lugar" agregado pro painel.

BEGIN;

CREATE OR REPLACE FUNCTION public.responder_pergunta_aprendizado(
  p_pergunta_id uuid,
  p_opcao text,
  p_texto text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pergunta public.learning_log%ROWTYPE;
  v_operador_id uuid;
  v_resposta_id uuid;
  v_resumo text;
BEGIN
  IF coalesce((SELECT public.current_operador_papel()), '') <> 'gestor' THEN
    RAISE EXCEPTION 'Só gestor pode responder perguntas do aprendizado';
  END IF;
  IF p_opcao IS NULL OR length(trim(p_opcao)) < 2 THEN
    RAISE EXCEPTION 'Escolha uma opção de resposta';
  END IF;

  v_operador_id := public.current_operador_id();

  SELECT * INTO v_pergunta
  FROM public.learning_log
  WHERE id = p_pergunta_id AND tipo = 'pergunta' AND status = 'aberto'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pergunta não encontrada ou já respondida';
  END IF;

  v_resumo := trim(p_opcao) ||
    coalesce(' — ' || nullif(trim(p_texto), ''), '');

  INSERT INTO public.learning_log (
    agente, tipo, severidade, titulo, resumo, status,
    parent_id, revisado_por, revisado_em, agente_alvo, detalhes
  ) VALUES (
    'agente-aprendizado', 'resposta_admin', 'info',
    'Resposta: ' || left(v_pergunta.titulo, 180),
    v_resumo,
    'observacao',
    p_pergunta_id, v_operador_id, now(), v_pergunta.agente_alvo,
    jsonb_build_object(
      'opcao', trim(p_opcao),
      'texto', nullif(trim(p_texto), ''),
      'chave_padrao', v_pergunta.detalhes->>'chave_padrao'
    )
  ) RETURNING id INTO v_resposta_id;

  UPDATE public.learning_log
  SET status = 'respondido',
      revisado_por = v_operador_id,
      revisado_em = now(),
      motivo_decisao = left(v_resumo, 500)
  WHERE id = p_pergunta_id;

  RETURN v_resposta_id;
END;
$$;

REVOKE ALL ON FUNCTION public.responder_pergunta_aprendizado(uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.responder_pergunta_aprendizado(uuid, text, text)
  TO authenticated, service_role;

CREATE VIEW public.v_sinal_ouro_trocas
WITH (security_invoker = on) AS
SELECT
  agent_name,
  oc_sugerida,
  oc_executada,
  count(*) AS casos,
  max(decidido_em) AS ultimo_caso
FROM public.v_agent_feedback_unificado
WHERE veredito = 'corrigida'
GROUP BY 1, 2, 3;

COMMIT;
