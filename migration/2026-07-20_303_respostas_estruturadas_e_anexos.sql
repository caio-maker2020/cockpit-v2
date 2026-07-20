-- 2026-07-20_303 — Loop de Aprendizado (F2, iteração 3): respostas
-- estruturadas em cadeia + anexos de prints (pedido Caio 2026-07-20).
--
-- 1) Bucket privado 'aprendizado' — prints que comprovam o certo/errado.
--    Upload e leitura só gestor (Caio/Isadora).
-- 2) RPC responder_pergunta_aprendizado v2 — além da opção, recebe a
--    cadeia de perguntas-seguimento respondidas (jsonb estruturado,
--    "quando X → fazer Y") e os caminhos dos prints anexados.

BEGIN;

-- ============================================================
-- 1. Bucket + RLS de storage (gestor-only)
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('aprendizado', 'aprendizado', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY aprendizado_upload_gestor ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'aprendizado'
    AND (SELECT public.current_operador_papel()) = 'gestor'
  );

CREATE POLICY aprendizado_select_gestor ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'aprendizado'
    AND (SELECT public.current_operador_papel()) = 'gestor'
  );

-- ============================================================
-- 2. RPC v2 (assinatura antiga removida pra evitar ambiguidade)
-- ============================================================

DROP FUNCTION IF EXISTS public.responder_pergunta_aprendizado(uuid, text, text);

CREATE OR REPLACE FUNCTION public.responder_pergunta_aprendizado(
  p_pergunta_id uuid,
  p_opcao text,
  p_texto text DEFAULT NULL,
  p_respostas jsonb DEFAULT NULL,
  p_imagens text[] DEFAULT NULL
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
  v_followups text;
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

  -- Resumo legível: opção + respostas dos seguimentos + texto + anexos
  SELECT string_agg(
           coalesce(r->>'pergunta', '?') || ' → ' ||
           coalesce(r->>'resposta', '(sem resposta)'),
           ' | '
         )
  INTO v_followups
  FROM jsonb_array_elements(coalesce(p_respostas, '[]'::jsonb)) AS r;

  v_resumo := trim(p_opcao)
    || coalesce(' | ' || nullif(v_followups, ''), '')
    || coalesce(' — ' || nullif(trim(p_texto), ''), '')
    || CASE WHEN coalesce(array_length(p_imagens, 1), 0) > 0
            THEN ' 📎 ' || array_length(p_imagens, 1) || ' print(s)'
            ELSE '' END;

  INSERT INTO public.learning_log (
    agente, tipo, severidade, titulo, resumo, status,
    parent_id, revisado_por, revisado_em, agente_alvo, detalhes
  ) VALUES (
    'agente-aprendizado', 'resposta_admin', 'info',
    'Resposta: ' || left(v_pergunta.titulo, 180),
    left(v_resumo, 2000),
    'observacao',
    p_pergunta_id, v_operador_id, now(), v_pergunta.agente_alvo,
    jsonb_build_object(
      'opcao', trim(p_opcao),
      'texto', nullif(trim(coalesce(p_texto, '')), ''),
      'respostas_estruturadas', coalesce(p_respostas, '[]'::jsonb),
      'imagens', to_jsonb(coalesce(p_imagens, '{}'::text[])),
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

REVOKE ALL ON FUNCTION public.responder_pergunta_aprendizado(uuid, text, text, jsonb, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.responder_pergunta_aprendizado(uuid, text, text, jsonb, text[])
  TO authenticated, service_role;

COMMIT;
